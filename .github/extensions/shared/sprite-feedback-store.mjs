/**
 * sprite-feedback-store.mjs — the durable, atomic-write store for reviewer
 * feedback on generated sprite art, persisted to `public/assets/generated/
 * sprite-review-feedback.json`.
 *
 * SHARED (not per-extension): originally built for the standalone `sprite-review`
 * canvas, now the single source of truth for the Sprite Generation Workflow
 * canvas (and, while it still exists, the Sprite Review surface it absorbed) —
 * every surface reads/writes the exact same file with the exact same schema, so
 * feedback recorded in one surface shows up identically in the other.
 * Deliberately separate from the asset-level favorite/disliked annotations the
 * sprite pipeline also tracks elsewhere.
 *
 * Every entry is a DISCRIMINATED UNION on `subjectType`:
 *   - `criterion` — per-criterion (judge/sensor) feedback on one variant's
 *     trace, keyed by `{briefId, runId, variantIndex, kind, criterion}`. This is
 *     the legacy (pre-subjectType) shape: an on-disk entry with NO `subjectType`
 *     field is normalized to `'criterion'` on read (see `normalizeSubjectType`),
 *     so older stores stay fully compatible with no migration step.
 *   - `sheet` — feedback on one rendered sprite SHEET image, keyed by
 *     `{briefId, runId, sheet}`.
 *   - `brief` — feedback on the BRIEF itself (the generation prompt/spec), keyed
 *     by `{briefId, runId}`.
 * `feedbackForRun` (the per-criterion selector) ignores non-criterion entries;
 * `sheetFeedback`/`briefFeedback` ignore entries of the other subject types.
 *
 * Concurrency: a lock file (`<path>.lock`) serializes writers across processes
 * (e.g. two canvas instances editing feedback at once), with stale-lock recovery
 * (a lock older than `staleLockMs` is treated as abandoned and removed) so a
 * crashed writer can never wedge the store permanently. Writes are atomic
 * (temp file + rename) so a reader never observes a partial write.
 *
 * @module shared/sprite-feedback-store
 */
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

/** Every entry lacking an on-disk `subjectType` predates the discriminated
 * union and is a per-criterion entry — normalize it as such. */
export function normalizeSubjectType(subjectType) {
  return subjectType === 'sheet' || subjectType === 'brief' ? subjectType : 'criterion';
}

/**
 * Identity → durable key. Each subject type gets its own key namespace (a
 * literal discriminator segment) so a criterion/sheet/brief identity can never
 * collide even when their other fields happen to coincide.
 */
export function feedbackKey(identity) {
  const subjectType = normalizeSubjectType(identity?.subjectType);
  if (subjectType === 'sheet') {
    return ['sheet', identity.briefId, identity.runId, identity.sheet]
      .map((part) => encodeURIComponent(part))
      .join('::');
  }
  if (subjectType === 'brief') {
    return ['brief', identity.briefId, identity.runId]
      .map((part) => encodeURIComponent(part))
      .join('::');
  }
  return [
    'criterion',
    identity.briefId,
    identity.runId,
    String(identity.variantIndex),
    identity.kind,
    identity.criterion,
  ]
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

/**
 * Per-criterion (judge/sensor) feedback for one run, indexed by
 * `{[variantIndex]: {sensor: {...}, judge: {...}}}`. Ignores `sheet`/`brief`
 * entries even when their briefId/runId match — this selector is
 * criterion-only (mixed-store compatible: a store containing all three
 * subject types still yields exactly the criterion subset here).
 */
export function feedbackForRun(store, briefId, runId) {
  const result = {};
  for (const entry of Object.values(store.entries)) {
    if (entry.briefId !== briefId || entry.runId !== runId) continue;
    if (normalizeSubjectType(entry.subjectType) !== 'criterion') continue;
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

/** Feedback on one rendered sheet image, or `null` if none recorded. */
export function sheetFeedback(store, briefId, runId, sheet) {
  for (const entry of Object.values(store.entries)) {
    if (entry.briefId !== briefId || entry.runId !== runId || entry.sheet !== sheet) continue;
    if (normalizeSubjectType(entry.subjectType) !== 'sheet') continue;
    return { verdict: entry.verdict, comment: entry.comment, recordedAt: entry.recordedAt };
  }
  return null;
}

/** Feedback on the brief itself, or `null` if none recorded. */
export function briefFeedback(store, briefId, runId) {
  for (const entry of Object.values(store.entries)) {
    if (entry.briefId !== briefId || entry.runId !== runId) continue;
    if (normalizeSubjectType(entry.subjectType) !== 'brief') continue;
    return { verdict: entry.verdict, comment: entry.comment, recordedAt: entry.recordedAt };
  }
  return null;
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
  const subjectType = normalizeSubjectType(input?.subjectType);
  const briefId = requireText(input?.briefId, 'briefId', 200);
  const runId = requireText(input?.runId, 'runId', 200);
  if (input?.verdict !== 'up' && input?.verdict !== 'down' && input?.verdict !== null) {
    throw validationError('verdict must be up, down, or null');
  }
  const comment = typeof input?.comment === 'string' ? input.comment.trim().slice(0, 1000) : '';

  let identity;
  if (subjectType === 'sheet') {
    const sheet = requireText(input?.sheet, 'sheet', 300);
    identity = { subjectType: 'sheet', briefId, runId, sheet };
  } else if (subjectType === 'brief') {
    identity = { subjectType: 'brief', briefId, runId };
  } else {
    const criterion = requireText(input?.criterion, 'criterion', 100);
    const variantIndex = Number(input?.variantIndex);
    if (!Number.isInteger(variantIndex) || variantIndex < 0) {
      throw validationError('variantIndex must be a non-negative integer');
    }
    if (input?.kind !== 'sensor' && input?.kind !== 'judge') {
      throw validationError('kind must be sensor or judge');
    }
    identity = {
      subjectType: 'criterion',
      briefId,
      runId,
      variantIndex,
      kind: input.kind,
      criterion,
    };
  }

  return withFeedbackLock(filePath, options, () => {
    const store = readFeedback(filePath, options);
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
      fd = options.openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      );
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
