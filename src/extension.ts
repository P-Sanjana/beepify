import * as vscode from 'vscode';
import { StateAnalyzer, Mood, isTestCommand, hasWarningOutput, TestState } from './StateAnalyzer';
import { ThemeManager } from './ThemeManager';
import { SoundPlayer } from './SoundPlayer';

const POLL_INTERVAL_MS = 5_000;

let pollTimer: NodeJS.Timeout | undefined;
let enabled = true;
let lastAppliedMood: Mood | undefined;

export function activate(context: vscode.ExtensionContext): void {

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  context.subscriptions.push(statusBar);

  const getConfig = () => vscode.workspace.getConfiguration('beepify');
  const detector = new StateAnalyzer(getConfig);
  const manager = new ThemeManager(statusBar, getConfig, context);
  // extensionKind:["ui"] in package.json ensures this always runs on the LOCAL
  // machine — the one with speakers — even when editing over SSH/WSL/containers.
  const soundPlayer = new SoundPlayer(getConfig, context.extensionPath);

  async function evaluateAndApply(forceApply = false, playSound = true, fromTest = false): Promise<void> {
    if (!enabled) { return; }

    const { errors, warnings } = detector.getDiagnosticCounts();
    const testState = detector.getTerminalTestState();

    // detectMood is purely terminal-driven: testState 'fail'→error, 'warn'→warning,
    // 'pass'→clean, 'unknown'→clean.
    const newMood: Mood = detector.detectMood({
      errorCount: errors, warningCount: warnings,
      currentMood: lastAppliedMood ?? 'clean', testState,
    });
    const moodChanged = newMood !== lastAppliedMood;

    if (moodChanged || forceApply) {
      lastAppliedMood = newMood;
      await manager.applyMood(newMood, true);
      if (playSound && fromTest) {
        // Play sound only when a terminal test result triggered the evaluation.
        soundPlayer.play(newMood, 'auto').catch(() => { /* non-critical */ });
      }
      if (fromTest) { notifyMoodChange(newMood, errors, warnings, testState); }
    } else {
      manager.updateStatusBar(newMood);
    }
  }

  function notifyMoodChange(
    mood: Mood, errors: number, warnings: number, testState: TestState
  ): void {
    const themes = manager.getMoodThemes();
    const def = themes[mood];
    const muted = !getConfig().get<boolean>('soundEnabled', true) ? ' 🔇' : '';

    let detail = def.description;
    if (mood === 'error') {
      detail = testState === 'fail'
        ? `Tests failed in terminal${muted}`
        : `${errors} error(s) detected${muted}`;
    } else if (mood === 'warning') {
      detail = testState === 'warn'
        ? `Test warnings in terminal${muted}`
        : `${warnings} warning(s)${muted}`;
    } else if (mood === 'clean' && testState === 'pass') {
      detail = `Tests passed ✓${muted}`;
    } else {
      detail = `${def.description}${muted}`;
    }

    vscode.window.setStatusBarMessage(
      `Code Mood → ${def.emoji} ${def.label}: ${detail}`, 5000
    );
  }

  function startPolling(): void {
    stopPolling();
    pollTimer = setInterval(() => evaluateAndApply(false, true), POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
  }

  // Terminal shell integration — test runner detection
  // Uses vscode.window.onDidStartTerminalShellExecution and
  // vscode.window.onDidEndTerminalShellExecution — stable global events since
  // VS Code 1.85, no per-terminal wiring needed.
  //
  // Covers ALL languages: jest, pytest, cargo test, go test, flutter test,
  // dotnet test, rspec, phpunit, mix test, swift test, ctest and 20+ more.
  //
  //   exitCode 0 + no warning output → testState = 'pass' → clean mood
  //   exitCode 0 + warning patterns  → testState = 'warn' → warning mood
  //   exitCode > 0                   → testState = 'fail' → error mood
  //
  // Output is streamed from execution.read() so we can check warning patterns
  // even when the runner exits 0.

  // Buffer terminal output per active execution (keyed by execution object)
  const outputBuffer = new Map<vscode.TerminalShellExecution, string>();

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(e => {
      const cmd = e.execution.commandLine?.value ?? '';
      if (!isTestCommand(cmd)) { return; }

      outputBuffer.set(e.execution, '');

      // Stream output so we can detect warning patterns on exit-code-0 runs
      const stream = e.execution.read();
      (async () => {
        for await (const chunk of stream) {
          outputBuffer.set(e.execution, (outputBuffer.get(e.execution) ?? '') + chunk);
        }
      })().catch(() => { /* non-critical */ });
    })
  );

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution(e => {
      const cmd = e.execution.commandLine?.value ?? '';
      if (!isTestCommand(cmd)) { return; }

      const output = outputBuffer.get(e.execution) ?? '';
      outputBuffer.delete(e.execution);
      const exitCode = e.exitCode;

      let state: TestState;
      if (exitCode === undefined) {
        state = 'unknown';           // shell didn't report — don't change mood
      } else if (exitCode !== 0) {
        state = 'fail';              // non-zero exit → error mood
      } else if (hasWarningOutput(output)) {
        state = 'warn';              // exit 0 but warnings in output → warning mood
      } else {
        state = 'pass';              // clean run → clean mood
      }

      detector.setTerminalTestState(state);

      // Re-evaluate immediately. fromTest=true unlocks theme/sound for the
      // first time (and keeps it unlocked for all future evaluations).
      evaluateAndApply(true, true, true /* fromTest */)
        .catch(err => console.error('Beepify: applyMood failed after test', err));
    })
  );

  // Language server diagnostics listener
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      detector.markDiagnosticsReady();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => detector.recordTyping())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('beepify')) { return; }
      lastAppliedMood = undefined;
      // Silent on settings changes — no sound blast while editing settings JSON
      evaluateAndApply(true, false);
    })
  );

  async function toggleMute(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('beepify');
    const muted = !cfg.get<boolean>('soundEnabled', true);
    // flip: if currently muted (soundEnabled=false), set to true and vice versa
    await cfg.update('soundEnabled', muted, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(
      muted ? 'Beepify: 🔊 Sound ON' : 'Beepify: 🔇 Muted', 3000
    );
  }

  // Mute is a keyboard shortcut (Cmd/Ctrl+Alt+M) and also inside the picker.
  statusBar.command = 'beepify.setMoodManually';

  // Mute keyboard shortcut command
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.toggleMute', toggleMute)
  );

  // Status bar click — shows mute toggle
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.setMoodManually', async () => {
      const muteItem: vscode.QuickPickItem = {
        label: getConfig().get<boolean>('soundEnabled', true) ? '🔇 Mute sounds' : '🔊 Unmute sounds',
        description: 'Toggle sound on/off (or press Cmd/Ctrl+Alt+M)',
      };

      const picked = await vscode.window.showQuickPick(
        [muteItem],
        { placeHolder: 'Beepify options — Esc to cancel' }
      );
      if (!picked) { return; }

      if (picked === muteItem) {
        await toggleMute();
      }
    })
  );

  // Toggle auto-switching on/off entirely
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.toggle', async () => {
      enabled = !enabled;
      if (enabled) {
        startPolling();
        lastAppliedMood = undefined;
        detector.resetFocusTimer();
        await evaluateAndApply(true, false); // re-enable silently
        vscode.window.showInformationMessage('Beepify: Auto-switching ON ✅');
      } else {
        stopPolling();
        statusBar.hide();
        await manager.restorePreviousTheme();
        vscode.window.showInformationMessage('Beepify: Auto-switching OFF ⏸');
      }
    })
  );

  // Status / debug info
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.showStatus', () => {
      const themes = manager.getMoodThemes();
      const cfg = getConfig();
      const { errors, warnings } = detector.getDiagnosticCounts();
      const mood = lastAppliedMood ?? 'clean';
      const testState = detector.getTerminalTestState();
      vscode.window.showInformationMessage([
        `Mood: ${themes[mood].emoji} ${themes[mood].label}`,
        `Errors: ${errors}  |  Warnings: ${warnings}`,
        `Terminal test state: ${testState}`,
        `Diagnostics ready: ${detector.isDiagnosticsReady() ? 'yes ✅' : 'waiting ⏳'}`,
        `Sound: ${cfg.get<boolean>('soundEnabled', true) ? '🔊 on' : '🔇 muted'}`,
        testState === 'unknown' ? '😌  Waiting for first test run' : '✅  Terminal-driven mode',
      ].join('\n'));
    })
  );

  // Customise colors
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.customizeColors', async () => {
      const themes = manager.getMoodThemes();
      const moodPick = await vscode.window.showQuickPick(
        (Object.keys(themes) as Mood[]).map(m => ({
          label: `${themes[m].emoji} ${themes[m].label}`, description: 'Customise bg & accent', mood: m,
        })),
        { placeHolder: 'Which mood to customise?' }
      );
      if (!moodPick) { return; }
      const bg = await vscode.window.showInputBox({
        prompt: `Background for ${themes[moodPick.mood].label} (hex e.g. #1a0a0a)`,
        placeHolder: '#1a0a0a',
        validateInput: v => /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'Enter a valid hex like #1a0a0a',
      });
      if (!bg) { return; }
      const accent = await vscode.window.showInputBox({
        prompt: `Accent / cursor for ${themes[moodPick.mood].label} (hex)`,
        placeHolder: '#ff4444',
        validateInput: v => /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'Enter a valid hex like #ff4444',
      });
      if (!accent) { return; }
      const cfg = vscode.workspace.getConfiguration('beepify');
      const overrides: Record<string, { bg: string; accent: string }> = cfg.get('colorOverrides', {});
      overrides[moodPick.mood] = { bg, accent };
      await cfg.update('colorOverrides', overrides, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`✅ Colors saved for ${themes[moodPick.mood].emoji} ${themes[moodPick.mood].label}!`);
    })
  );

  // Reset colors
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.resetColors', async () => {
      await vscode.workspace.getConfiguration('beepify')
        .update('colorOverrides', {}, vscode.ConfigurationTarget.Global);
      lastAppliedMood = undefined;
      await evaluateAndApply(true, false);
      vscode.window.showInformationMessage('Beepify: Custom colours reset ♻️');
    })
  );

  // Open settings
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings', '@ext:sanjana-podduturi.beepify'
      );
    })
  );

  enabled = getConfig().get<boolean>('enabled', true);

  if (enabled) {
    startPolling();

    // Always apply the clean (green) theme on startup to clear any stale mood
    // (e.g. 'error' left in settings.json from a previous session).
    // Theme only changes from clean once a terminal test command completes.
    manager.applyStartupClean()
      .then(() =>
        // Force-apply clean through the full applyMood() path so VS Code
        // reliably loads the green theme. A raw config.update() in
        // applyStartupClean alone can lose a race against VS Code's own
        // startup theme-load from settings.json.
        evaluateAndApply(true, false)
      )
      .catch(err => console.error('Beepify: startup clean apply failed', err));
  }

  context.subscriptions.push({ dispose: stopPolling });
  context.subscriptions.push({ dispose: () => detector.dispose() });
  context.subscriptions.push({ dispose: () => soundPlayer.dispose() });

  console.log('Beepify activated 🎵');
}

export function deactivate(): void {
  if (pollTimer) { clearInterval(pollTimer); }
}