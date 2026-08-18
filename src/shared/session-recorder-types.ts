/**
 * Minimal session-recorder interface shared between the engine and game layers.
 *
 * The engine (`src/engine/`) cannot import from `src/game/`, so this interface
 * lives in `src/shared/` and is implemented by the concrete
 * {@link PlayerSessionRecorder} in `src/game/ai/player-session-recorder.ts`.
 *
 * `MainGameScene` accepts a `SessionRecorder` via its options so callers
 * (labs, bootstrap code) can inject a recorder without the engine ever knowing
 * about the concrete implementation.
 */
import type { InputState } from './input.js';
import type { DenBossDiagnostics } from './den-boss-telemetry-types.js';
import type { WeaponTelemetrySummary } from './weapon-telemetry-types.js';

/**
 * Who is currently driving the recorded player.
 *
 * `'AI'` — the behavior-tree runner is supplying input. `'MANUAL'` — a human has
 * taken over (e.g. via the AI Runner lab's "Take manual control" button). The
 * recorder tags every event with the active controller so a mixed AI/human
 * recording can be attributed segment-by-segment during AI tuning.
 */
export type SessionController = 'AI' | 'MANUAL';

/** Quick stats without copying the full event array. */
export interface SessionRecorderStats {
  totalEvents: number;
  totalSamples: number;
  totalKills: number;
  durationMs: number;
  /** Minimum player health ratio observed across the run (0..1). */
  minHealthPercent?: number;
  /** Downward crossings through the 20% health threshold. */
  closeCallCount?: number;
  /** Downward crossings through the 50% health threshold. */
  lowHealthCount?: number;
  /** Which controller is currently driving the recorded player. */
  controller: SessionController;
  /**
   * Per-run weapon accuracy rollup (swings, connecting hits, accuracy, multi-hit
   * rate). Present only when the recorder was created with `recordWeaponTelemetry`
   * and the world therefore has an active telemetry collector; omitted otherwise.
   */
  weaponTelemetry?: WeaponTelemetrySummary;
  /**
   * Floor 2 den-boss diagnostic rollup accumulated by the recorder — the same
   * contract the headless runner puts on `RunStats.denBoss`. Present only when
   * the session actually observed a den floor.
   */
  denBoss?: DenBossDiagnostics;
}

/**
 * Minimal recorder interface consumed by the engine layer.
 *
 * The full {@link PlayerSessionRecorder} in `src/game/ai/player-session-recorder.ts`
 * implements this interface and adds typed event access.
 */
export interface SessionRecorder {
  /** Must be called once per simulation step with the current input state. */
  tick(inputState: InputState): void;
  /** Emit a kill event. Pass the 1-based kill index. */
  onKill(killIndex: number): void;
  /** Emit a levelup event for the given new level. */
  onLevelUp(level: number): void;
  /** Emit a quest event with a human-readable note. */
  onQuestEvent(note: string): void;
  /** Emit an NPC interaction event. */
  onNpcEvent(note: string): void;
  /**
   * Record a control handover between the AI runner and a human player.
   *
   * Emits a clearly-labeled `control` event and re-tags subsequent events with
   * the new controller. A no-op when the controller is unchanged, so callers can
   * invoke it idempotently. Used by the AI Runner lab's manual-takeover toggle.
   */
  onControlChange(controller: SessionController, note?: string): void;
  /** Quick stats without copying the full event array. */
  getStats(): SessionRecorderStats;
  /** Serialize the captured session without requiring the concrete recorder type. */
  toJsonl?(): string;
  /**
   * Trigger a browser download of the recorded session as JSONL.
   * No-op in non-browser environments.
   */
  download(filename?: string): void;
  /** Clear all recorded events and reset counters. */
  reset(): void;
}
