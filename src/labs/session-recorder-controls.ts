/**
 * Shared session-recorder controls for labs.
 *
 * Records a full play session (human in {@link createFloor1Lab}, AI in the
 * AI runner lab) as structured JSONL telemetry at the same fidelity as the
 * headless AI runner, then lets you download / copy / summarize it for AI
 * behavior tuning.
 *
 * This used to live in its own `session-recorder-lab`. It now mounts directly
 * into the Floor 1 lab and the AI runner lab so recording is available wherever
 * the scenario actually runs — no separate lab required.
 *
 * Usage:
 * ```ts
 * const recorder = createSessionRecorderControls();
 * // inject into MainGameScene options:
 * sessionRecorderFactory: recorder.factory,
 * // mount the UI panel into the lab's controls element:
 * recorder.mount(controls);
 * // on lab teardown:
 * recorder.destroy();
 * ```
 *
 * The panel root element ({@link SessionRecorderControls.element}) is created
 * once and is safe to re-append after a container's `innerHTML` is rebuilt — the
 * recorded log is preserved across re-mounts.
 */
import { eventsToJsonl, summarizeEvents } from '../game/ai/event-log.js';
import {
  createPlayerSessionRecorder,
  type PlayerSessionRecorder,
} from '../game/ai/player-session-recorder.js';
import type { GameWorld } from '../core/world.js';
import type { SessionController, SessionRecorder } from '../shared/session-recorder-types.js';

export interface SessionRecorderControls {
  /**
   * Inject this into `MainGameScene` options as `sessionRecorderFactory`. The
   * scene calls it with the live world + player entity once the scene loads.
   */
  factory: (world: GameWorld, playerEid: number) => SessionRecorder;
  /** Persistent panel root. Safe to re-append after a container re-render. */
  readonly element: HTMLElement;
  /** Append the panel into a container (no-op if already mounted there). */
  mount(container: HTMLElement): void;
  /**
   * Record a control handover (AI ⇄ human) and surface it in the panel so the
   * recording clearly shows when manual play started/stopped.
   */
  onControlChange(controller: SessionController, note?: string): void;
  /** Stop the status ticker and detach the panel. */
  destroy(): void;
}

/**
 * Create a self-contained session-recorder controls panel plus the factory used
 * to wire the recorder into a `MainGameScene`.
 */
export function createSessionRecorderControls(
  options: { title?: string; initialController?: SessionController } = {},
): SessionRecorderControls {
  const title = options.title ?? 'Session Recorder';
  const initialController: SessionController = options.initialController ?? 'MANUAL';

  let recorder: PlayerSessionRecorder | null = null;

  // ── Panel DOM (created once, persists across re-mounts) ────────────────────
  const root = document.createElement('div');
  root.style.cssText =
    'margin-top:12px;padding:10px;border:1px solid rgba(96,165,250,0.35);' +
    'border-radius:6px;background:rgba(15,23,42,0.6);font-family:monospace;';

  const header = document.createElement('div');
  header.textContent = `⏺ ${title}`;
  header.style.cssText = 'font-size:12px;font-weight:bold;color:#93c5fd;margin-bottom:8px;';
  root.appendChild(header);

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;';
  root.appendChild(buttonRow);

  const logEl = document.createElement('pre');
  logEl.style.cssText =
    'margin:0;padding:8px;font-size:11px;line-height:1.4;white-space:pre-wrap;' +
    'word-break:break-word;max-height:220px;overflow-y:auto;' +
    'background:rgba(0,0,0,0.6);color:#e2e8f0;border-radius:6px;';
  logEl.textContent = 'Recording starts automatically when the scene loads.\n';
  root.appendChild(logEl);

  function log(msg: string): void {
    logEl.textContent += `${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = 'padding:5px 9px;cursor:pointer;font-size:11px;';
    btn.onclick = onClick;
    buttonRow.appendChild(btn);
    return btn;
  }

  makeButton('⬇ Download JSONL', () => {
    if (!recorder) {
      log('[error] Recorder not ready — wait for the scene to load.');
      return;
    }
    const stats = recorder.getStats();
    if (stats.totalEvents === 0) {
      log('[warn] No events recorded yet.');
      return;
    }
    recorder.download();
    log(`[download] Saved ${stats.totalEvents} events (${stats.totalSamples} samples).`);
  });

  makeButton('📊 Show Summary', () => {
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
  });

  makeButton('📋 Copy JSONL', () => {
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
  });

  makeButton('🗑 Reset', () => {
    if (!recorder) {
      log('[warn] Recorder not ready.');
      return;
    }
    recorder.reset();
    lastEventCount = 0;
    log('[reset] Recording cleared.');
  });

  // ── Status ticker ──────────────────────────────────────────────────────────
  let lastEventCount = 0;
  const statusTimer = setInterval(() => {
    if (!recorder) return;
    const stats = recorder.getStats();
    if (stats.totalEvents !== lastEventCount) {
      lastEventCount = stats.totalEvents;
      log(
        `[${new Date().toLocaleTimeString()}] ` +
          `events=${stats.totalEvents}  samples=${stats.totalSamples}  ` +
          `kills=${stats.totalKills}  duration=${(stats.durationMs / 1000).toFixed(1)}s  ` +
          `control=${stats.controller}`,
      );
    }
  }, 2000);

  // ── Public API ──────────────────────────────────────────────────────────────
  const factory = (world: GameWorld, playerEid: number): SessionRecorder => {
    recorder = createPlayerSessionRecorder(world, playerEid, { initialController });
    lastEventCount = 0;
    log(`[session-recorder] Recording started (control=${initialController}).`);
    return recorder;
  };

  function onControlChange(controller: SessionController, note?: string): void {
    if (!recorder) {
      log('[control] Recorder not ready — control change not recorded.');
      return;
    }
    recorder.onControlChange(controller, note);
    const banner =
      controller === 'MANUAL'
        ? '🎮 MANUAL CONTROL — you are now driving the player'
        : '🤖 AI CONTROL — the runner resumed driving';
    log(`[control] ${banner}${note ? ` (${note})` : ''}.`);
  }

  function mount(container: HTMLElement): void {
    if (root.parentElement !== container) {
      container.appendChild(root);
    }
  }

  function destroy(): void {
    clearInterval(statusTimer);
    recorder = null;
    root.remove();
  }

  return {
    factory,
    element: root,
    mount,
    onControlChange,
    destroy,
  };
}
