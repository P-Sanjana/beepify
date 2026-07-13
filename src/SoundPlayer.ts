import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Mood } from './StateAnalyzer';

// ---------------------------------------------------------------------------
// Architectural decision — two play modes:
//
//  'auto'   Triggered by diagnostics / poll / terminal test events.
//           Respects COOLDOWN_MS (mass-failure guard) and isPlaying (overlap
//           guard) so 50 failing tests don't fire 50 sounds.
//
//  'manual' Triggered by the user explicitly picking a mood from the picker.
//           Kills any in-flight sound immediately and starts the new one.
//           No cooldown, no overlap guard — the user made a deliberate choice
//           and must hear it. "Stop old → play new" is the correct UX.
//
// Race-condition fix — generation counter:
//   Every play() increments `this.generation`. Each startPlay() captures the
//   generation value at the moment it starts. The finally block only clears
//   `isPlaying` and `currentChild` when its captured generation still matches
//   the current one. If a newer play() has already started (incremented the
//   counter), the stale finally block becomes a no-op and leaves the new
//   play's state intact.
//
//   Without this: kill() + new spawn() + old-play's-finally running clears
//   currentChild right after the new spawn assigned it → new sound orphaned.
//
// OS audio:
//   macOS   → afplay -v (ships with every Mac)
//   Windows → PowerShell System.Media.SoundPlayer (WAV only, no volume API)
//   Linux   → paplay → aplay → ffplay  (fallback chain)
//   All spawned as child processes so kill() works cross-platform.
// ---------------------------------------------------------------------------

export type PlayMode = 'auto' | 'manual';

const MOOD_WAV: Record<Mood, string> = {
  error: 'error.wav',
  warning: 'warning.wav',
  clean: 'clean.wav',
};

export class SoundPlayer {
  private readonly soundsDir: string;

  // Auto-mode guards
  private readonly COOLDOWN_MS = 2_000;
  private lastAutoPlayAt = 0;
  private isPlaying = false;

  // The running OS audio process — stored so manual plays can kill it.
  private currentChild: cp.ChildProcess | null = null;

  // Incremented on every play() call. Each startPlay() captures its own
  // value; the finally block only clears shared state when the captured
  // value still matches, preventing the race condition described above.
  private generation = 0;

  constructor(
    private readonly getConfig: () => vscode.WorkspaceConfiguration,
    extensionPath: string,
  ) {
    this.soundsDir = path.join(extensionPath, 'sounds');
  }


  public async play(mood: Mood, mode: PlayMode = 'auto'): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.get<boolean>('soundEnabled', true)) { return; }

    const volume = cfg.get<number>('soundVolume', 80) / 100;
    if (volume <= 0) { return; }

    const wavFile = path.join(this.soundsDir, MOOD_WAV[mood]);
    if (!fs.existsSync(wavFile)) {
      console.error(`Beepify: missing sound file: ${wavFile}`);
      return;
    }

    if (mode === 'manual') {
      // Kill whatever is currently playing immediately, then start the new sound.
      // Increment generation BEFORE killing so the old startPlay's finally sees
      // a stale generation and becomes a no-op, leaving our new state intact.
      this.generation++;
      this.killCurrent();
      await this.startPlay(wavFile, volume, this.generation);

    } else {
      // Auto mode: cooldown + overlap guard.
      const now = Date.now();
      if (now - this.lastAutoPlayAt < this.COOLDOWN_MS) { return; }
      if (this.isPlaying) { return; }
      this.generation++;
      this.lastAutoPlayAt = now;
      await this.startPlay(wavFile, volume, this.generation);
    }
  }

  /** Kills the running OS audio process. Safe to call when nothing is playing. */
  private killCurrent(): void {
    if (!this.currentChild) { return; }
    try {
      this.currentChild.kill(); // SIGTERM on mac/linux; equivalent on windows
    } catch {
      /* process may have already exited — ignore */
    }
    this.currentChild = null;
    this.isPlaying = false;
  }

  /** Spawns the OS audio player and waits for it to finish (or be killed). */
  private async startPlay(filePath: string, volume: number, myGen: number): Promise<void> {
    this.isPlaying = true;
    try {
      await this.spawnPlayer(filePath, volume);
    } catch (e) {
      console.error('Beepify: playback error', e);
    } finally {
      // Only clear shared state if it is still the active play() call.
      // If a newer manual pick has already started (generation > myGen), leave
      // isPlaying=true and currentChild set so the new play runs correctly.
      if (this.generation === myGen) {
        this.currentChild = null;
        this.isPlaying = false;
      }
    }
  }

  private spawnPlayer(filePath: string, volume: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (process.platform === 'darwin') {
        const child = cp.spawn('afplay', ['-v', String(volume), filePath],
          { stdio: 'ignore' }
        );
        this.currentChild = child;
        child.on('close', () => resolve());
        child.on('error', () => resolve()); // afplay not found — resolve silently
        return;
      }

      if (process.platform === 'win32') {
        const esc = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        const child = cp.spawn(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-Command',
            `Add-Type -AssemblyName System.Windows.Forms; ` +
            `(New-Object System.Media.SoundPlayer '${esc}').PlaySync()`,
          ],
          { stdio: 'ignore', windowsHide: true }
        );
        this.currentChild = child;
        child.on('close', () => resolve());
        child.on('error', () => resolve());
        return;
      }

      const paVol = Math.round(volume * 65536); // paplay expects 0–65536
      const child1 = cp.spawn('paplay', [`--volume=${paVol}`, filePath],
        { stdio: 'ignore' }
      );
      this.currentChild = child1;

      const tryAplay = () => {
        const child2 = cp.spawn('aplay', [filePath], { stdio: 'ignore' });
        this.currentChild = child2;
        child2.on('close', (code) => {
          if (code === 0) { resolve(); return; }
          const child3 = cp.spawn(
            'ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath],
            { stdio: 'ignore' }
          );
          this.currentChild = child3;
          child3.on('close', () => resolve());
          child3.on('error', () => resolve());
        });
        child2.on('error', () => {
          // aplay also missing — try ffplay directly
          const child3 = cp.spawn(
            'ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath],
            { stdio: 'ignore' }
          );
          this.currentChild = child3;
          child3.on('close', () => resolve());
          child3.on('error', () => resolve()); // nothing works — give up silently
        });
      };

      child1.on('close', (code) => { if (code === 0) { resolve(); } else { tryAplay(); } });
      child1.on('error', () => tryAplay()); // paplay not on PATH
    });
  }

  public dispose(): void { this.killCurrent(); }
}
