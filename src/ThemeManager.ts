import * as vscode from 'vscode';
import { Mood } from './StateAnalyzer';

export interface ThemeDefinition {
  label: string;
  themeName: string;
  emoji: string;
  description: string;
}

const MOOD_THEMES: Record<Mood, ThemeDefinition> = {
  error: { label: 'Error', themeName: 'Bug Beats: Error 😡', emoji: '😡', description: 'Errors detected — fix them!' },
  warning: { label: 'Warning', themeName: 'Bug Beats: Warning ⚠️', emoji: '⚠️', description: 'Warnings in your code' },
  clean: { label: 'Clean', themeName: 'Bug Beats: Clean 😌', emoji: '😌', description: 'No errors — looking good!' },
};

export class ThemeManager {
  private previousTheme: string | undefined;
  /** globalState key where the user's original (non-BugBeats) theme name is saved. */
  private static readonly ORIGIN_KEY = 'bugBeats.originalTheme';

  constructor(
    private readonly statusBar: vscode.StatusBarItem,
    private readonly getConfig: () => vscode.WorkspaceConfiguration,
    private readonly context: vscode.ExtensionContext,
  ) {}

  public async applyMood(mood: Mood, forceApply: boolean): Promise<void> {
    const def = MOOD_THEMES[mood];
    const workbench = vscode.workspace.getConfiguration('workbench');
    const currentTheme: string = workbench.get('colorTheme', '');

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

    // Apply the named theme
    if (currentTheme !== def.themeName || forceApply) {
      await workbench.update('colorTheme', def.themeName, vscode.ConfigurationTarget.Global);
    }

    // Apply custom color overrides via workbench.colorCustomizations
    await this.applyColorOverrides(mood);

    this.updateStatusBar(mood, def);
  }

  private async applyColorOverrides(mood: Mood): Promise<void> {
    const overrides: Record<string, { bg: string; accent: string }> =
      this.getConfig().get('colorOverrides', {});

    const moodOverride = overrides[mood];
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

    await workbench.update(
      'colorCustomizations',
      Object.keys(cleaned).length > 0 ? cleaned : undefined,
      vscode.ConfigurationTarget.Global
    );
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
   * Called once on activation. If VS Code reopened with a theme still active
   * (left over from a previous session), silently restores the user's original
   * theme so the IDE always starts with the user's own theme.
   */
  public async restoreOnStartup(): Promise<void> {
    const workbench = vscode.workspace.getConfiguration('workbench');
    const currentTheme = workbench.get<string>('colorTheme', '');

    // Nothing to do — IDE is already on the user's own theme.
    if (!this.isManagedTheme(currentTheme)) { return; }

    // Look up the theme that was active before we ever touched it.
    const original = this.context.globalState.get<string>(ThemeManager.ORIGIN_KEY);
    if (!original) { return; } // no record — leave as is rather than guessing

    this.previousTheme = original;
    await workbench.update('colorTheme', original, vscode.ConfigurationTarget.Global);
    // Also clear any leftover color customizations.
    await workbench.update('colorCustomizations', undefined, vscode.ConfigurationTarget.Global);
  }

  public isManagedTheme(themeName: string): boolean {
    return Object.values(MOOD_THEMES).some(d => d.themeName === themeName);
  }

  public getMoodThemes(): Record<Mood, ThemeDefinition> {
    return MOOD_THEMES;
  }
}