import * as vscode from 'vscode';
import { Mood } from './StateAnalyzer';

export interface ThemeDefinition {
  label: string;
  themeName: string;
  emoji: string;
  description: string;
}

const MOOD_THEMES: Record<Mood, ThemeDefinition> = {
  error: { label: 'Error', themeName: 'Beepify: Error', emoji: '😡', description: 'Errors detected - fix them!' },
  warning: { label: 'Warning', themeName: 'Beepify: Warning', emoji: '⚠️', description: 'Warnings in your code' },
  clean: { label: 'Clean', themeName: 'Beepify: Clean', emoji: '😌', description: 'No errors - looking good!' },
};

export class ThemeManager {
  private previousTheme: string | undefined;
  /** globalState key where the user's original (non-BugBeats) theme name is saved. */
  private static readonly ORIGIN_KEY = 'beepify.originalTheme';

  constructor(
    private readonly statusBar: vscode.StatusBarItem,
    private readonly getConfig: () => vscode.WorkspaceConfiguration,
    private readonly context: vscode.ExtensionContext,
  ) {}

  public async applyMood(mood: Mood, forceApply: boolean): Promise<void> {
    const def = MOOD_THEMES[mood];

    // Re-read config each time to get the latest value (never stale).
    const currentTheme: string =
      vscode.workspace.getConfiguration('workbench').get('colorTheme', '');

    // Save previous theme if it's not one of ours (in-memory fast path)
    if (!this.isManagedTheme(currentTheme)) {
      this.previousTheme = currentTheme;
      // Also persist to globalState so we can restore after an extension restart.
      // Only write when the theme actually changes to avoid redundant writes.
      const saved = this.context.globalState.get<string>(ThemeManager.ORIGIN_KEY);
      if (saved !== currentTheme) {
        void this.context.globalState.update(ThemeManager.ORIGIN_KEY, currentTheme);
      }
    }

    // Apply the named theme — always write when forceApply so VS Code actually
    // reloads the theme even if the name hasn't changed (e.g. cross-session).
    if (currentTheme !== def.themeName || forceApply) {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', def.themeName, vscode.ConfigurationTarget.Global);
    }

    // Apply custom color overrides via workbench.colorCustomizations.
    // Done as a separate step after the theme write has resolved.
    await this.applyColorOverrides(mood);

    this.updateStatusBar(mood, def);
  }

  private async applyColorOverrides(mood: Mood): Promise<void> {
    const overrides: Record<string, { bg: string; accent: string }> =
      this.getConfig().get('colorOverrides', {});

    const moodOverride = overrides[mood];

    // Re-read workbench config fresh (post colorTheme write) to avoid stale cache.
    const workbench = vscode.workspace.getConfiguration('workbench');
    const existing: Record<string, string> = workbench.get('colorCustomizations', {});

    // Remove any previously applied mood overrides (keys we control)
    const MANAGED_KEYS = [
      'editor.background',
      'editorCursor.foreground',
      'activityBar.background',
      'sideBar.background',
      'statusBar.background',
      'tab.activeBackground',
      'terminal.background',
    ];
    const cleaned: Record<string, string> = { ...existing };
    for (const k of MANAGED_KEYS) {
      delete cleaned[k];
    }

    if (moodOverride) {
      const { bg, accent } = moodOverride;
      // Darken the bg slightly for sidebar/activity bar
      const darkerBg = this.darkenHex(bg, 0.07);

      cleaned['editor.background'] = bg;
      cleaned['editorCursor.foreground'] = accent;
      cleaned['activityBar.background'] = darkerBg;
      cleaned['sideBar.background'] = darkerBg;
      cleaned['statusBar.background'] = accent;
      cleaned['tab.activeBackground'] = this.darkenHex(bg, -0.05); // slightly lighter
      cleaned['terminal.background'] = bg;
    }

    const newValue = Object.keys(cleaned).length > 0 ? cleaned : undefined;

    // Only write colorCustomizations when there is actually something to set or
    // something to clear — skip the redundant write entirely when both old and
    // new state are empty. This prevents an unnecessary async config write that
    // can race with the preceding colorTheme write and cause VS Code to
    // temporarily flicker back to the old theme.
    const hadCustomizations = Object.keys(existing).some(k => MANAGED_KEYS.includes(k));
    if (moodOverride || hadCustomizations) {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorCustomizations', newValue, vscode.ConfigurationTarget.Global);
    }
  }

  /** Lighten (negative amount) or darken (positive) a hex colour by a ratio */
  private darkenHex(hex: string, amount: number): string {
    const n = parseInt(hex.replace('#', ''), 16);
    let r = (n >> 16) & 0xff;
    let g = (n >> 8) & 0xff;
    let b =  n & 0xff;
    const factor = 1 - amount;
    r = Math.max(0, Math.min(255, Math.round(r * factor)));
    g = Math.max(0, Math.min(255, Math.round(g * factor)));
    b = Math.max(0, Math.min(255, Math.round(b * factor)));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  public updateStatusBar(mood: Mood, def?: ThemeDefinition): void {
    const d = def ?? MOOD_THEMES[mood];
    this.statusBar.text = `$(paintcan) ${d.emoji} ${d.label}`;
    this.statusBar.tooltip = `Code Mood: ${d.description}\nClick to set mood manually`;
    this.statusBar.show();
  }

  public async restorePreviousTheme(): Promise<void> {
    if (this.previousTheme) {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', this.previousTheme, vscode.ConfigurationTarget.Global);
      // Clear any color customisations we applied
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorCustomizations', undefined, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * Called once on activation. Always applies the clean (green) theme so VS Code
   * starts in a known good state regardless of what was left in settings.json
   * from a previous session. Clears any leftover colorCustomizations too.
   */
  public async applyStartupClean(): Promise<void> {
    const cleanDef = MOOD_THEMES['clean'];
    const workbench = vscode.workspace.getConfiguration('workbench');
    const currentTheme = workbench.get<string>('colorTheme', '');

    // Save the user's original theme before we ever touch it.
    if (!this.isManagedTheme(currentTheme)) {
      this.previousTheme = currentTheme;
      const saved = this.context.globalState.get<string>(ThemeManager.ORIGIN_KEY);
      if (saved !== currentTheme) {
        void this.context.globalState.update(ThemeManager.ORIGIN_KEY, currentTheme);
      }
    }

    // Always write the clean theme on startup so any stale mood theme
    // (e.g. Error left over from last session) is immediately replaced.
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', cleanDef.themeName, vscode.ConfigurationTarget.Global);

    // Clear any leftover color customizations from a previous session.
    const existing: Record<string, string> =
      vscode.workspace.getConfiguration('workbench').get('colorCustomizations', {});
    const MANAGED_KEYS = [
      'editor.background', 'editorCursor.foreground', 'activityBar.background',
      'sideBar.background', 'statusBar.background', 'tab.activeBackground', 'terminal.background',
    ];
    const hadCustomizations = Object.keys(existing).some(k => MANAGED_KEYS.includes(k));
    if (hadCustomizations) {
      const cleaned = { ...existing };
      for (const k of MANAGED_KEYS) { delete cleaned[k]; }
      await vscode.workspace
        .getConfiguration('workbench')
        .update(
          'colorCustomizations',
          Object.keys(cleaned).length > 0 ? cleaned : undefined,
          vscode.ConfigurationTarget.Global
        );
    }
  }

  public isManagedTheme(themeName: string): boolean {
    return Object.values(MOOD_THEMES).some(d => d.themeName === themeName);
  }

  public getMoodThemes(): Record<Mood, ThemeDefinition> {
    return MOOD_THEMES;
  }
}