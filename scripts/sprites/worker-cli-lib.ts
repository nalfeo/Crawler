/**
 * Pure helpers for `sprites:worker` CLI drain-mode.
 *
 * Extracted into its own module so tests can import them without triggering
 * `worker-cli.ts`'s top-level `main()` / signal-handler registration.
 */

import type { WorkerStatus } from './worker.js';

/**
 * Returns true for common truthy env-var spellings. Case-insensitive.
 * `''`, `undefined`, `'0'`, `'false'`, `'no'`, `'off'` are all falsy so that
 * `SPRITES_WORKER_DRAIN=0` or `=false` disables drain the same way an unset
 * variable does.
 */
export function isTruthyEnv(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  return (
    normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off'
  );
}

export function parsePositiveIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  variableName: string,
): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${variableName} must be a positive integer, got '${value}'`);
  }
  return parsed;
}

/**
 * Builds an onStatus wrapper that counts consecutive `idle` events and calls
 * `abort()` once `maxEmptyPolls` empty polls have been observed in a row. Any
 * non-idle work event resets the counter so a drain run that hits intermittent
 * work still processes it before exiting.
 *
 * The abort is fired exactly once, even if additional `idle` events arrive
 * before the worker actually notices the aborted signal.
 */
export function createDrainOnStatus(options: {
  readonly base: (status: WorkerStatus) => void;
  readonly maxEmptyPolls: number;
  readonly abort: () => void;
  readonly onDrain?: () => void;
}): (status: WorkerStatus) => void {
  let idleCount = 0;
  let aborted = false;
  return (status) => {
    if (status.type === 'idle') {
      idleCount += 1;
      if (!aborted && idleCount >= options.maxEmptyPolls) {
        aborted = true;
        options.onDrain?.();
        options.abort();
      }
    } else if (status.type !== 'stopping') {
      idleCount = 0;
    }
    options.base(status);
  };
}

/**
 * Resolves the drain-mode exit code:
 *   - Not in drain mode: always 0 (long-running mode exits only on signal).
 *   - Drain mode + zero errors observed: 0.
 *   - Drain mode + one or more `error` statuses observed: 1.
 *
 * Rationale: in drain mode a transient processing error leaves the message
 * unacked in Azure Queue for its visibility timeout (~900s). Without a
 * safety-net trigger, an exit-0 workflow would hide that failure from CI
 * for the full 15-minute window — and the message could stay stuck if
 * nothing else fires. Failing the CI step surfaces the error immediately so
 * a maintainer can investigate + re-run.
 */
export function resolveDrainExitCode(options: {
  readonly drainMode: boolean;
  readonly errorCount: number;
}): number {
  if (!options.drainMode) return 0;
  return options.errorCount > 0 ? 1 : 0;
}
