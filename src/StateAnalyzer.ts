import * as vscode from 'vscode';

export type Mood = 'error' | 'warning' | 'clean';
export const ALL_MOODS: Mood[] = ['error', 'warning', 'clean'];

export type TestState = 'unknown' | 'pass' | 'fail' | 'warn';

export interface MoodContext {
  errorCount: number;
  warningCount: number;
  currentMood: Mood;
  testState: TestState;
}

// All commands that, when they exit non-zero mean "tests failed".
// Matches the full list from the faahhh-on-fail reference extension.
const TEST_RUNNER_PATTERNS: RegExp[] = [
  // JavaScript / TypeScript
  /\bjest\b/, /\bvitest\b/, /\bmocha\b/, /\bava\b/, /\bjasmine\b/, /\bkarma\b/,
  /\bnpm\s+(run\s+)?test\b/, /\byarn\s+(run\s+)?test\b/,
  /\bpnpm\s+(run\s+)?test\b/, /\bbun\s+test\b/,
  // Python
  /\bpytest\b/, /\bpython\s+-m\s+pytest\b/, /\bpython\s+-m\s+unittest\b/, /\bnose2\b/,
  // Rust
  /\bcargo\s+test\b/,
  // Go
  /\bgo\s+test\b/,
  // Dart / Flutter
  /\bdart\s+test\b/, /\bflutter\s+test\b/,
  // .NET
  /\bdotnet\s+test\b/,
  // Java / JVM — allow flags between the binary and `test` subcommand
  // e.g. `mvn -Dtest=SomeClass test`, `gradle clean test`, `gradlew :mod:test`
  /\bmvn\b.*\btest\b/, /\bgradle\b.*\btest\b/, /\bgradlew\b.*\btest\b/,
  // Ruby
  /\brspec\b/, /\brake\s+test\b/, /\brails\s+test\b/, /\bminitest\b/,
  // PHP
  /\bphpunit\b/, /\bcomposer\s+test\b/,
  // Elixir
  /\bmix\s+test\b/,
  // Swift
  /\bswift\s+test\b/,
  // C / C++
  /\bctest\b/, /\bmake\s+test\b/, /\bmake\s+check\b/,
];

// Patterns in terminal output that indicate warnings even on exit code 0
const WARN_OUTPUT_PATTERNS: RegExp[] = [
  /\d+\s+warning/i,
  /\bwarning:/i,
  /\bDeprecationWarning\b/i,
  /\bdeprecation\b/i,
  /\bpending\b.*\btest/i,
  /\bskipped\b.*\btest/i,
];

export function isTestCommand(commandLine: string): boolean {
  return TEST_RUNNER_PATTERNS.some(p => p.test(commandLine));
}

export function hasWarningOutput(output: string): boolean {
  return WARN_OUTPUT_PATTERNS.some(p => p.test(output));
}

export class StateAnalyzer {
  // Gate: suppress error/warning from *diagnostics* until the first real
  // onDidChangeDiagnostics fires, to avoid stale VS Code session cache.
  private diagnosticsReady = false;

  // Terminal test result — set by extension.ts when a test command finishes.
  // This is intentionally separate from diagnostics so test failures from
  // runners that don't push to the Language Server still affect state.
  private terminalTestState: TestState = 'unknown';

  constructor(private readonly config: () => vscode.WorkspaceConfiguration) {}

  public markDiagnosticsReady(): void { this.diagnosticsReady = true; }
  public isDiagnosticsReady(): boolean { return this.diagnosticsReady; }

  public setTerminalTestState(state: TestState): void {
    this.terminalTestState = state;
  }
  public getTerminalTestState(): TestState { return this.terminalTestState; }

  public detectMood(ctx: MoodContext): Mood {
    const cfg = this.config();
    const { errorCount, warningCount, testState } = ctx;

    const errorThreshold = cfg.get<number>('errorThreshold', 1);
    const warnThreshold = cfg.get<number>('warningThreshold', 5);

    // 1. Terminal test result (error/warning/clean)
    // Terminal test state takes priority over diagnostics for error/warning/clean
    // because many test runners (jest, pytest, cargo test, go test …) never push
    // to VS Code's diagnostic API — they only write to the terminal.
    if (testState === 'fail') { return 'error'; }
    if (testState === 'warn') { return 'warning'; }
    if (testState === 'pass') { return 'clean'; }

    // 2. Language-server diagnostics (gated until ready)
    // Only read diagnostics after the first real onDidChangeDiagnostics event,
    // which prevents stale session cache from triggering Error on launch.
    if (this.diagnosticsReady) {
      if (errorCount >= errorThreshold) { return 'error'; }
      if (warningCount >= warnThreshold) { return 'warning'; }
    }

    // 3. Default to clean
    return 'clean';
  }

  public getDiagnosticCounts(): { errors: number; warnings: number } {
    const all = vscode.languages.getDiagnostics().flatMap(([, d]) => d);
    const errors = all.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = all.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
    return { errors, warnings };
  }

  public recordTyping(): void {
    // Focus mode removed — stub kept for API compatibility
  }

  public resetFocusTimer(): void {
    // Focus mode removed — stub kept for API compatibility
  }

  public dispose(): void { /* nothing */ }
}