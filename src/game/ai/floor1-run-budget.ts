import { GAME } from '../../shared/constants.js';

/** Official Floor 1 active-time budget shared by AI planning and evaluation. */
export const FLOOR1_ACTIVE_TIME_BUDGET_MS = 6 * 60 * 1000;

/** Raw simulation cap that leaves room for safe-room-credited official wins. */
export const FLOOR1_DEFAULT_MAX_FRAMES = Math.ceil(
  (FLOOR1_ACTIVE_TIME_BUDGET_MS * 1.1) / GAME.DELTA_MS,
);

export function planningDeadlineMsFromFrameBudget(maxFrames: number): number | null {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 0) {
    throw new Error(
      `Invalid maxFrames "${String(maxFrames)}": expected a non-negative safe integer.`,
    );
  }
  return maxFrames === 0 ? null : maxFrames * GAME.DELTA_MS;
}

export function resolveFloor1PlanningDeadlineMs(
  objectiveDeadlineMs: number,
  runnerDeadlineMs: number | null = null,
): number {
  if (!Number.isFinite(objectiveDeadlineMs) || objectiveDeadlineMs < 0) {
    throw new Error(
      `Invalid Floor 1 objective deadline "${String(objectiveDeadlineMs)}": expected a finite non-negative number.`,
    );
  }
  if (runnerDeadlineMs !== null && (!Number.isFinite(runnerDeadlineMs) || runnerDeadlineMs < 0)) {
    throw new Error(
      `Invalid runner planning deadline "${String(runnerDeadlineMs)}": expected null or a finite non-negative number.`,
    );
  }
  return Math.min(
    objectiveDeadlineMs,
    FLOOR1_ACTIVE_TIME_BUDGET_MS,
    runnerDeadlineMs ?? Number.POSITIVE_INFINITY,
  );
}
