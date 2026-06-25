/**
 * Quest-progress stall detection for headless Floor-1 runs.
 *
 * Pure, deterministic helpers that decide when a run has stalled — i.e. the
 * QUEST LOG has stopped advancing — rather than when the AI has merely failed to
 * reach a movement *goal*. Keyed on the same coarse floor-progress fingerprint
 * the in-AI watchdog uses (quest objective ticks + completions + gold; see
 * {@link computeFloorProgressScore}), so a knockback/kite deadlock or a
 * "can't find the next NPC" wander trips it while legitimately slow combat
 * (which still drips gold + kills) keeps it alive.
 *
 * Extracted from the runner so the decision + diagnostics are unit-testable
 * without constructing a full world or running thousands of frames.
 */
import type { QuestState } from '../../shared/quest-types.js';

/** A point-in-time view of quest-log progress, for diagnostics. */
export interface QuestProgressSummary {
  /** Every quest currently present in the log (accepted). */
  accepted: string[];
  /** Quests whose status is `complete`. */
  completed: string[];
  /** Accepted but not yet complete — the quests a stall is waiting on. */
  incomplete: string[];
}

/** Summarize quest-log state into accepted / completed / incomplete id lists. */
export function summarizeQuestProgress(quests: Iterable<QuestState>): QuestProgressSummary {
  const accepted: string[] = [];
  const completed: string[] = [];
  const incomplete: string[] = [];
  for (const quest of quests) {
    accepted.push(quest.questId);
    if (quest.status === 'complete') {
      completed.push(quest.questId);
    } else {
      incomplete.push(quest.questId);
    }
  }
  return { accepted, completed, incomplete };
}

/**
 * Tracks a near-monotonic floor-progress score frame-to-frame and reports when
 * it has been frozen for at least `stallLimitFrames`. A non-positive limit
 * disables detection (the tracker still records the best score for diagnostics).
 *
 * Deterministic: the verdict depends only on the scores and frame indices fed
 * in, never on wall-clock time, so identical inputs always stall identically.
 */
export class QuestProgressStallTracker {
  private best = Number.NEGATIVE_INFINITY;
  private lastProgressFrame = 0;
  private started = false;

  constructor(private readonly stallLimitFrames: number) {}

  /**
   * Feed the current frame's floor-progress score. Returns true the first frame
   * the stall window is exceeded (and every frame thereafter until the score
   * improves). The first call only seeds the baseline and never stalls.
   */
  update(score: number, frame: number): boolean {
    if (!this.started) {
      this.started = true;
      this.best = score;
      this.lastProgressFrame = frame;
      return false;
    }
    if (score > this.best) {
      this.best = score;
      this.lastProgressFrame = frame;
      return false;
    }
    if (this.stallLimitFrames <= 0) {
      return false;
    }
    return frame - this.lastProgressFrame >= this.stallLimitFrames;
  }

  /** Frames since the score last improved (0 before the first update). */
  framesSinceProgress(frame: number): number {
    return this.started ? frame - this.lastProgressFrame : 0;
  }
}

/**
 * Build a human-readable stall diagnostic naming the completed and stalled-on
 * quests, so a headless gate failure says *why* a seed could not progress
 * instead of just timing out after the full budget.
 */
export function formatQuestStallReason(
  quests: Iterable<QuestState>,
  stallFrames: number,
  deltaMs: number,
): string {
  const { completed, incomplete } = summarizeQuestProgress(quests);
  const seconds = ((stallFrames * deltaMs) / 1000).toFixed(0);
  const done = completed.length > 0 ? completed.join(', ') : '(none)';
  const waiting = incomplete.length > 0 ? incomplete.join(', ') : '(no active quest)';
  return `quest progress frozen for ${seconds}s — completed: [${done}], stalled on: [${waiting}]`;
}
