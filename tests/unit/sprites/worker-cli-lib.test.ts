import { describe, expect, it, vi } from 'vitest';
import type { WorkerStatus } from '../../../scripts/sprites/worker.js';
import {
  createDrainOnStatus,
  isTruthyEnv,
  parsePositiveIntegerEnv,
  resolveDrainExitCode,
} from '../../../scripts/sprites/worker-cli-lib.js';

describe('isTruthyEnv', () => {
  it('treats common truthy values as true', () => {
    expect(isTruthyEnv('true')).toBe(true);
    expect(isTruthyEnv('TRUE')).toBe(true);
    expect(isTruthyEnv('1')).toBe(true);
    expect(isTruthyEnv('yes')).toBe(true);
    expect(isTruthyEnv('  on ')).toBe(true);
  });

  it('treats common falsy values as false', () => {
    expect(isTruthyEnv(undefined)).toBe(false);
    expect(isTruthyEnv('')).toBe(false);
    expect(isTruthyEnv('   ')).toBe(false);
    expect(isTruthyEnv('0')).toBe(false);
    expect(isTruthyEnv('false')).toBe(false);
    expect(isTruthyEnv('FALSE')).toBe(false);
    expect(isTruthyEnv('no')).toBe(false);
    expect(isTruthyEnv('off')).toBe(false);
  });
});

describe('parsePositiveIntegerEnv', () => {
  it('uses the default for an unset or blank value', () => {
    expect(parsePositiveIntegerEnv(undefined, 1, 'TEST_VALUE')).toBe(1);
    expect(parsePositiveIntegerEnv('   ', 2, 'TEST_VALUE')).toBe(2);
  });

  it('accepts a positive integer and rejects invalid concurrency', () => {
    expect(parsePositiveIntegerEnv('2', 1, 'TEST_VALUE')).toBe(2);
    expect(() => parsePositiveIntegerEnv('0', 1, 'TEST_VALUE')).toThrow(/TEST_VALUE/);
    expect(() => parsePositiveIntegerEnv('1.5', 1, 'TEST_VALUE')).toThrow(/TEST_VALUE/);
  });
});

describe('createDrainOnStatus', () => {
  const idle: WorkerStatus = { type: 'idle' };
  const processing: WorkerStatus = { type: 'processing', briefId: 'test' };

  it('aborts after maxEmptyPolls consecutive idle events', () => {
    const abort = vi.fn();
    const base = vi.fn();
    const onDrain = vi.fn();
    const wrapped = createDrainOnStatus({ base, maxEmptyPolls: 3, abort, onDrain });

    wrapped(idle);
    expect(abort).not.toHaveBeenCalled();
    wrapped(idle);
    expect(abort).not.toHaveBeenCalled();
    wrapped(idle);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(onDrain).toHaveBeenCalledTimes(1);
    // base is always called through, even on the drain-triggering event.
    expect(base).toHaveBeenCalledTimes(3);
  });

  it('resets the idle counter on processing events', () => {
    const abort = vi.fn();
    const base = vi.fn();
    const wrapped = createDrainOnStatus({ base, maxEmptyPolls: 3, abort });

    wrapped(idle);
    wrapped(idle);
    wrapped(processing);
    wrapped(idle);
    wrapped(idle);
    expect(abort).not.toHaveBeenCalled();
    wrapped(idle);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('only aborts once even if extra idle events arrive after the trigger', () => {
    const abort = vi.fn();
    const base = vi.fn();
    const wrapped = createDrainOnStatus({ base, maxEmptyPolls: 2, abort });
    wrapped(idle);
    wrapped(idle);
    wrapped(idle);
    wrapped(idle);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('passes non-idle/non-processing events straight through to base', () => {
    const abort = vi.fn();
    const base = vi.fn();
    const wrapped = createDrainOnStatus({ base, maxEmptyPolls: 3, abort });
    const stopping: WorkerStatus = { type: 'stopping' };
    wrapped(stopping);
    expect(base).toHaveBeenCalledWith(stopping);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe('resolveDrainExitCode', () => {
  it('always returns 0 outside drain mode, even if errors were observed', () => {
    expect(resolveDrainExitCode({ drainMode: false, errorCount: 0 })).toBe(0);
    expect(resolveDrainExitCode({ drainMode: false, errorCount: 5 })).toBe(0);
  });

  it('returns 0 in drain mode when no errors were observed', () => {
    expect(resolveDrainExitCode({ drainMode: true, errorCount: 0 })).toBe(0);
  });

  it('returns 1 in drain mode when any error was observed', () => {
    expect(resolveDrainExitCode({ drainMode: true, errorCount: 1 })).toBe(1);
    expect(resolveDrainExitCode({ drainMode: true, errorCount: 42 })).toBe(1);
  });
});
