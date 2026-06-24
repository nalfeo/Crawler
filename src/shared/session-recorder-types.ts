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

/** Quick stats without copying the full event array. */
export interface SessionRecorderStats {
  totalEvents: number;
  totalSamples: number;
  totalKills: number;
  durationMs: number;
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
  /** Quick stats without copying the full event array. */
  getStats(): SessionRecorderStats;
  /**
   * Trigger a browser download of the recorded session as JSONL.
   * No-op in non-browser environments.
   */
  download(filename?: string): void;
  /** Clear all recorded events and reset counters. */
  reset(): void;
}
