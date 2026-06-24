/**
 * Session Recorder Lab
 *
 * Record a full human play session as structured JSONL telemetry at the same
 * fidelity as the AI headless runner, then compare behavior side-by-side.
 *
 * ## How to enable
 * Open the dev server and append `?lab=session-recorder-lab` to the URL:
 * ```
 * http://localhost:5173/?lab=session-recorder-lab
 * ```
 * (The default Vite port is 5173; adjust if your dev server uses a different port.)
 * The game starts immediately. Recording begins automatically once the scene
 * loads — no extra setup needed.
 *
 * ## How to download logs
 * After playing, click **⬇ Download JSONL** in the controls panel on the right.
 * The file is saved as `session-<timestamp>.jsonl` and contains one JSON object
 * per line. Each line is a {@link PlayerSessionEvent} compatible with
 * {@link summarizeEvents} and {@link eventsToJsonl}.
 *
 * ## Other controls
 * - **📊 Show Summary** — print a wasted-time / behavior summary to the log panel.
 * - **📋 Copy JSONL** — copy the event stream to the clipboard.
 * - **🗑 Reset** — discard the current recording and start fresh.
 *
 * ## Comparing human vs AI
 * ```ts
 * const humanSummary = summarizeEvents(humanEvents);
 * const aiSummary    = summarizeEvents(aiEvents);
 * // diff wigglePct, statePct, travelEfficiency, kill cadence
 * ```
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { createFloor1MainSceneOptions } from '../../bootstrap/floor1-main-scene-options.js';
import { BootScene, MainGameScene } from '../../engine/index.js';
import { summarizeEvents, eventsToJsonl } from '../../game/ai/event-log.js';
import {
  createPlayerSessionRecorder,
  type PlayerSessionRecorder,
} from '../../game/ai/player-session-recorder.js';
import type { SessionRecorder } from '../../shared/session-recorder-types.js';
import type { GameWorld } from '../../core/world.js';
import { GAME } from '../../shared/constants.js';
import { registerLab, type LabCategory } from '../registry.js';

// ---------------------------------------------------------------------------
// Lab implementation
// ---------------------------------------------------------------------------

function createSessionRecorderLab(canvas: HTMLElement, controls: HTMLElement): () => void {
  // Shared recorder reference — populated when the scene calls the factory.
  let recorder: PlayerSessionRecorder | null = null;

  const sessionRecorderFactory = (world: GameWorld, playerEid: number): SessionRecorder => {
    recorder = createPlayerSessionRecorder(world, playerEid);
    log('[session-recorder] Recording started.');
    return recorder;
  };

  // ── Phaser game ──────────────────────────────────────────────────────────
  const baseSceneOptions = createFloor1MainSceneOptions();
  const sceneOptions = {
    ...baseSceneOptions,
    sessionRecorderFactory,
  };

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: canvas,
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
    backgroundColor: '#111111',
    pixelArt: true,
    roundPixels: true,
    scene: [BootScene, new MainGameScene(sceneOptions)],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
  };

  const game = new Phaser.Game(config);

  // ── Log panel ────────────────────────────────────────────────────────────
  const logEl = document.createElement('pre');
  logEl.style.cssText =
    'margin:0;padding:8px;font-size:11px;line-height:1.4;white-space:pre-wrap;' +
    'word-break:break-word;max-height:300px;overflow-y:auto;' +
    'background:rgba(0,0,0,0.6);color:#e2e8f0;border-radius:6px;font-family:monospace;';
  logEl.textContent = 'Waiting for game to load…\n';

  function log(msg: string): void {
    logEl.textContent += `${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── Status ticker ────────────────────────────────────────────────────────
  let lastEventCount = 0;
  const statusTimer = setInterval(() => {
    if (!recorder) return;
    const stats = recorder.getStats();
    if (stats.totalEvents !== lastEventCount) {
      lastEventCount = stats.totalEvents;
      log(
        `[${new Date().toLocaleTimeString()}] ` +
          `events=${stats.totalEvents}  samples=${stats.totalSamples}  ` +
          `kills=${stats.totalKills}  duration=${(stats.durationMs / 1000).toFixed(1)}s`,
      );
    }
  }, 2000);

  // ── Instruction banner ───────────────────────────────────────────────────
  const banner = document.createElement('div');
  banner.style.cssText =
    'margin-bottom:8px;padding:8px 10px;background:rgba(30,58,138,0.5);' +
    'border:1px solid rgba(96,165,250,0.4);border-radius:6px;' +
    'color:#bfdbfe;font-size:11px;line-height:1.5;font-family:monospace;';
  banner.innerHTML =
    '<strong style="color:#93c5fd">How to enable:</strong> ' +
    'append <code style="background:rgba(0,0,0,0.4);padding:0 3px;border-radius:3px">' +
    '?lab=session-recorder-lab</code> to the dev-server URL.<br>' +
    '<strong style="color:#93c5fd">How to download:</strong> ' +
    'play normally, then click <strong>⬇ Download JSONL</strong> below.';
  controls.insertBefore(banner, controls.firstChild);

  // ── lil-gui controls ─────────────────────────────────────────────────────
  type ControlsWithGui = HTMLElement & { __labGui?: GUI };
  const host = controls as ControlsWithGui;
  if (host.__labGui) {
    host.__labGui.destroy();
  }
  const gui = new GUI({ container: controls, title: 'Session Recorder' });
  host.__labGui = gui;

  gui
    .add(
      {
        download: () => {
          if (!recorder) {
            log('[error] Recorder not ready — wait for the game to load.');
            return;
          }
          const stats = recorder.getStats();
          if (stats.totalEvents === 0) {
            log('[warn] No events recorded yet.');
            return;
          }
          recorder.download();
          log(`[download] Saved ${stats.totalEvents} events (${stats.totalSamples} samples).`);
        },
      },
      'download',
    )
    .name('⬇ Download JSONL');

  gui
    .add(
      {
        summary: () => {
          if (!recorder) {
            log('[error] Recorder not ready.');
            return;
          }
          const events = recorder.getEvents();
          if (events.length === 0) {
            log('[warn] No events to summarize.');
            return;
          }
          const summary = summarizeEvents(events);
          log('── Summary ──────────────────────────');
          log(`  samples:     ${summary.totalSamples}`);
          log(`  duration:    ${(summary.durationMs / 1000).toFixed(1)}s`);
          log(`  kills:       ${summary.kills}`);
          log(`  final level: ${summary.finalLevel}`);
          log(`  wiggle:      ${summary.wigglePct}%`);
          log(`  idle:        ${summary.idlePct}%`);
          log(`  stuck:       ${summary.stuckPct}%`);
          log(`  efficiency:  ${(summary.travelEfficiency * 100).toFixed(1)}%`);
          const topStates = Object.entries(summary.statePct)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([s, p]) => `${s}=${p}%`)
            .join('  ');
          log(`  states:      ${topStates}`);
          log('─────────────────────────────────────');
        },
      },
      'summary',
    )
    .name('📊 Show Summary');

  gui
    .add(
      {
        copyJsonl: () => {
          if (!recorder) {
            log('[error] Recorder not ready.');
            return;
          }
          const events = recorder.getEvents();
          if (events.length === 0) {
            log('[warn] No events recorded.');
            return;
          }
          const jsonl = eventsToJsonl(events);
          void navigator.clipboard.writeText(jsonl).then(() => {
            log(`[copy] ${events.length} events copied to clipboard as JSONL.`);
          });
        },
      },
      'copyJsonl',
    )
    .name('📋 Copy JSONL');

  gui
    .add(
      {
        reset: () => {
          if (!recorder) {
            log('[warn] Recorder not ready.');
            return;
          }
          recorder.reset();
          lastEventCount = 0;
          log('[reset] Recording cleared.');
        },
      },
      'reset',
    )
    .name('🗑 Reset Recording');

  controls.appendChild(logEl);

  log('Tip: Play the game normally. Events are recorded automatically.');
  log(
    'Use "⬇ Download JSONL" to save the session, then compare with AI runs via summarizeEvents().',
  );
  log('──────────────────────────────────────────────────');

  // ── Cleanup ──────────────────────────────────────────────────────────────
  return () => {
    clearInterval(statusTimer);
    gui.destroy();
    game.destroy(true);
  };
}

registerLab('session-recorder-lab', {
  name: 'Session Recorder',
  description: 'Record a human player session as JSONL telemetry for AI behavior tuning.',
  category: 'Meta' as LabCategory,
  create: createSessionRecorderLab,
});
