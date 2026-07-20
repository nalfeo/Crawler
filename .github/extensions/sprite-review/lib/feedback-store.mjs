import {
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

export const FEEDBACK_VERSION = 1;
const FEEDBACK_LOCK_TIMEOUT_MS = 2000;
const FEEDBACK_STALE_LOCK_MS = 30000;
const FEEDBACK_LOCK_RETRY_MS = 2;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function feedbackKey({ briefId, runId, variantIndex, kind, criterion }) {
  return [briefId, runId, String(variantIndex), kind, criterion]
    .map((part) => encodeURIComponent(part))
    .join('::');
}

export function readFeedback(filePath, fs = { existsSync, readFileSync }) {
  if (!fs.existsSync(filePath)) return { version: FEEDBACK_VERSION, entries: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return { version: FEEDBACK_VERSION, entries: {} };
    throw error;
  }
  if (
    parsed?.version !== FEEDBACK_VERSION ||
    !parsed.entries ||
    typeof parsed.entries !== 'object'
  ) {
    throw new Error(`Unsupported sprite-review feedback schema in ${filePath}`);
  }
  return parsed;
}

export function feedbackForRun(store, briefId, runId) {
  const result = {};
  for (const entry of Object.values(store.entries)) {
    if (entry.briefId !== briefId || entry.runId !== runId) continue;
    const variant = String(entry.variantIndex);
    result[variant] ??= { sensor: {}, judge: {} };
    result[variant][entry.kind][entry.criterion] = {
      verdict: entry.verdict,
      comment: entry.comment,
      recordedAt: entry.recordedAt,
    };
  }
  return result;
}

export function saveFeedback(filePath, input, overrides = {}) {
  const options = {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    randomUUID,
    now: () => new Date(),
    lockTimeoutMs: FEEDBACK_LOCK_TIMEOUT_MS,
    staleLockMs: FEEDBACK_STALE_LOCK_MS,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) options[key] = value;
  }
  const briefId = requireText(input?.briefId, 'briefId', 200);
  const runId = requireText(input?.runId, 'runId', 200);
  const criterion = requireText(input?.criterion, 'criterion', 100);
  const variantIndex = Number(input?.variantIndex);
  if (!Number.isInteger(variantIndex) || variantIndex < 0) {
    throw validationError('variantIndex must be a non-negative integer');
  }
  if (input?.kind !== 'sensor' && input?.kind !== 'judge') {
    throw validationError('kind must be sensor or judge');
  }
  if (input?.verdict !== 'up' && input?.verdict !== 'down' && input?.verdict !== null) {
    throw validationError('verdict must be up, down, or null');
  }
  const comment = typeof input?.comment === 'string' ? input.comment.trim().slice(0, 1000) : '';
  return withFeedbackLock(filePath, options, () => {
    const store = readFeedback(filePath, options);
    const identity = { briefId, runId, variantIndex, kind: input.kind, criterion };
    const key = feedbackKey(identity);
    if (input.verdict === null && comment.length === 0) {
      delete store.entries[key];
    } else {
      store.entries[key] = {
        ...identity,
        verdict: input.verdict,
        comment,
        recordedAt: options.now().toISOString(),
      };
    }
    const tempPath = `${filePath}.tmp.${options.randomUUID()}`;
    options.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    options.renameSync(tempPath, filePath);
    return store.entries[key] ?? null;
  });
}

function withFeedbackLock(filePath, options, fn) {
  const lockPath = `${filePath}.lock`;
  const deadline = options.now().getTime() + options.lockTimeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(options.lockTimeoutMs / FEEDBACK_LOCK_RETRY_MS));
  let fd;
  for (let attempt = 0; attempt < maxAttempts && fd === undefined; attempt += 1) {
    try {
      fd = options.openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR);
      options.writeFileSync(lockPath, options.now().toISOString(), 'utf8');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (isStaleLock(lockPath, options)) {
        try {
          options.unlinkSync(lockPath);
          continue;
        } catch {}
      }
      if (options.now().getTime() >= deadline) {
        const lockError = new Error('feedback store is locked');
        lockError.code = 'feedback-locked';
        throw lockError;
      }
      sleepMs(FEEDBACK_LOCK_RETRY_MS);
      continue;
    }
  }
  if (fd === undefined) {
    const lockError = new Error('feedback store is locked');
    lockError.code = 'feedback-locked';
    throw lockError;
  }
  try {
    return fn();
  } finally {
    try {
      options.closeSync(fd);
      options.unlinkSync(lockPath);
    } catch {}
  }
}

function isStaleLock(lockPath, options) {
  try {
    const ageMs = options.now().getTime() - options.statSync(lockPath).mtimeMs;
    return ageMs > options.staleLockMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sleepMs(ms) {
  try {
    Atomics.wait(sleepBuffer, 0, 0, ms);
  } catch {
    // Fallback when Atomics.wait/SharedArrayBuffer is unavailable: no delay.
    // Deadline + attempt caps still bound lock acquisition duration.
  }
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`${field} is required`);
  }
  return value.trim().slice(0, maxLength);
}

function validationError(message) {
  const error = new Error(message);
  error.code = 'invalid-feedback';
  return error;
}
