import * as vscode from 'vscode';
import { StateAnalyzer, Mood, isTestCommand, hasWarningOutput, TestState } from './StateAnalyzer';
import { ThemeManager } from './ThemeManager';
import { SoundPlayer } from './SoundPlayer';

const POLL_INTERVAL_MS = 5_000;

let pollTimer: NodeJS.Timeout | undefined;
let enabled = true;
let lastAppliedMood: Mood | undefined;
let manualOverride: Mood | undefined;
// True once the user has run at least one test. Until then the IDE's own
// theme is left untouched — theme + sound are activated only by tests.
let testHasRun = false;

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

  // fromTest: true when called directly from the test-end handler. Unlocks
  // theme application for all future calls once the first test has been run.
  async function evaluateAndApply(forceApply = false, playSound = true, fromTest = false): Promise<void> {
    if (!enabled) { return; }

    // Manual mood picks always take effect immediately, regardless of testHasRun.
    if (manualOverride) {
      await manager.applyMood(manualOverride, false);
      return;
    }

    // Hold off applying any mood theme until the user runs their first test.
    // This keeps the IDE's default/user-chosen theme intact on startup and
    // during normal editing — theme + sound are gated on actual test runs.
    if (!testHasRun && !fromTest) {
      manager.updateStatusBar('clean'); // show status bar label without touching the theme
      return;
    }
    if (fromTest) { testHasRun = true; } // unlock permanently after first test

    const { errors, warnings } = detector.getDiagnosticCounts();
    const testState = detector.getTerminalTestState();

    const newMood = detector.detectMood({
      errorCount: errors, warningCount: warnings,
      currentMood: lastAppliedMood ?? 'clean', testState,
    });
    const moodChanged = newMood !== lastAppliedMood;

    if (moodChanged || forceApply) {
      lastAppliedMood = newMood;
      await manager.applyMood(newMood, true);
      if (playSound) {
        // 'auto' — subject to cooldown + overlap guard (prevents sound spam
        // from rapid diagnostic bursts or 50 failing tests at once)
        soundPlayer.play(newMood, 'auto').catch(() => { /* non-critical */ });
      }
      notifyMoodChange(newMood, errors, warnings, testState);
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
      evaluateAndApply(true, true, true /* fromTest */);
    })
  );

  // Language server diagnostics listener
  // Only marks diagnosticsReady=true once the FIRST real change event fires
  // this prevents showing Error on launch from stale VS Code session cache.
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      detector.markDiagnosticsReady();
      // Silent — diagnostics change as you type, only test-run completion plays a sound.
      evaluateAndApply(false, false);
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

  // Manual mood picker — opened by clicking the status bar
  context.subscriptions.push(
    vscode.commands.registerCommand('beepify.setMoodManually', async () => {
      const themes = manager.getMoodThemes();

      const moodItems: vscode.QuickPickItem[] = (Object.keys(themes) as Mood[]).map(mood => ({
        label: `${themes[mood].emoji} ${themes[mood].label}`,
        description: themes[mood].description,
        detail: mood === lastAppliedMood ? '  ← current' : undefined,
      }));

      const autoItem: vscode.QuickPickItem = {
        label: '🔄 Auto (let the extension decide)',
        description: 'Clear override — re-evaluate immediately with sound',
      };

      const muteItem: vscode.QuickPickItem = {
        label: getConfig().get<boolean>('soundEnabled', true) ? '🔇 Mute sounds' : '🔊 Unmute sounds',
        description: 'Toggle sound on/off (or press Cmd/Ctrl+Alt+M)',
      };

      const picked = await vscode.window.showQuickPick(
        [...moodItems, autoItem, muteItem],
        { placeHolder: 'Set mood or options — Esc to cancel' }
      );
      if (!picked) { return; }

      // Mute toggle
      if (picked === muteItem) {
        await toggleMute();
        return;
      }

      // Return to auto
      if (picked === autoItem) {
        manualOverride = undefined;
        lastAppliedMood = undefined;
        detector.resetFocusTimer();
        await evaluateAndApply(true, true);
        vscode.window.showInformationMessage('Beepify: Back to auto mode 🔄');
        return;
      }

      // Set a specific mood
      const mood = (Object.keys(themes) as Mood[]).find(
        m => `${themes[m].emoji} ${themes[m].label}` === picked.label
      );
      if (!mood) { return; }

      manualOverride = mood;
      lastAppliedMood = mood;
      await manager.applyMood(mood, true);
      // 'manual' — kills any currently playing sound and starts this one
      // immediately. No cooldown, no overlap guard. User chose it; they hear it.
      soundPlayer.play(mood, 'manual').catch(() => { /* non-critical */ });
      vscode.window.showInformationMessage(
        `Beepify: Manually set to ${themes[mood].emoji} ${themes[mood].label}`
      );
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
        manualOverride ? `⚠️  Manual override: ${manualOverride}` : '✅  Auto mode',
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

    // Restore the user's original IDE theme if a mood theme was left active from
    // a previous session. This runs asynchronously but resolves before the first
    // test completes, so the user sees their own theme from the very first frame.
    manager.restoreOnStartup().catch(() => { /* non-critical */ });

    // Show the status bar label without touching the IDE theme.
    manager.updateStatusBar('clean');
  }

  context.subscriptions.push({ dispose: stopPolling });
  context.subscriptions.push({ dispose: () => detector.dispose() });
  context.subscriptions.push({ dispose: () => soundPlayer.dispose() });

  console.log('Beepify activated 🎵');
}

export function deactivate(): void {
  if (pollTimer) { clearInterval(pollTimer); }
}