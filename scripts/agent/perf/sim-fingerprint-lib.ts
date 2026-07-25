/**
 * Pure helpers behind the deterministic gameplay fingerprint.
 *
 * The fingerprint exists to answer exactly one question for the
 * **perf-optimizer** workflow: *did this optimization change the simulation?*
 * A performance change is only legitimate if the game plays byte-for-byte
 * identically afterwards, so we hash the full `RunStats` of the Floor-1 gate
 * sample and compare hashes before/after.
 *
 * Everything here is pure and synchronous so it can be unit-tested without
 * running the (multi-minute) headless sample.
 */
import { createHash } from 'node:crypto';

/**
 * Keys whose values are wall-clock measurements and therefore legitimately
 * differ between two runs of the *same* simulation. They are the only thing an
 * optimization is *supposed* to change, so they must never participate in the
 * fingerprint. Matched case-insensitively against the key name at any depth.
 */
const NON_DETERMINISTIC_KEY_PATTERN = /^wall([_-]?clock)?time(ms|sec|s)?$/i;

export interface FingerprintRunKey {
  weapon: string;
  seed: number;
}

export interface FingerprintRun extends FingerprintRunKey {
  /** Canonicalized, wall-time-free `RunStats` for this (weapon, seed) pair. */
  stats: unknown;
}

export interface Fingerprint {
  /** Schema version so a canonicalization change invalidates stale baselines. */
  version: number;
  /** Sorted `weapon:seed` labels covered by this fingerprint. */
  runs: string[];
  /** sha256 over the canonical JSON of every run, in sorted order. */
  hash: string;
  /** Per-run hash, so a drift report can name the exact divergent runs. */
  runHashes: Record<string, string>;
  /** Canonical per-run payload, retained so drift can be diffed field-by-field. */
  payload: Record<string, unknown>;
}

export const FINGERPRINT_VERSION = 1;

export function runLabel(key: FingerprintRunKey): string {
  return `${key.weapon}:${key.seed}`;
}

/**
 * Recursively rebuild a value with object keys sorted and non-deterministic
 * (wall-clock) keys dropped, so `JSON.stringify` yields a stable byte sequence
 * regardless of property insertion order.
 *
 * `undefined` object properties are dropped (matching `JSON.stringify`), but
 * `undefined` inside an array becomes `null` for the same reason.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Array.from (not .map) so sparse holes are visited and normalized rather
    // than surviving as holes.
    return Array.from(value, (entry) => (entry === undefined ? null : canonicalize(entry)));
  }
  if (value === null || typeof value !== 'object') {
    // -0 and 0 stringify differently ("0" vs "0"), but Object.is distinguishes
    // them; normalize so a sign-of-zero flip can never masquerade as drift.
    if (typeof value === 'number' && Object.is(value, -0)) {
      return 0;
    }
    return value;
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (NON_DETERMINISTIC_KEY_PATTERN.test(key)) {
      continue;
    }
    const entry = source[key];
    if (entry === undefined) {
      continue;
    }
    result[key] = canonicalize(entry);
  }
  return result;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build a fingerprint over a set of completed runs. Run order is normalized, so
 * a parallel sweep and a sequential sweep produce the same fingerprint.
 */
export function buildFingerprint(runs: readonly FingerprintRun[]): Fingerprint {
  const labels = runs.map(runLabel);
  const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate fingerprint runs: ${[...new Set(duplicates)].sort().join(', ')}`);
  }

  const sorted = [...runs].sort((a, b) => runLabel(a).localeCompare(runLabel(b)));
  const runHashes: Record<string, string> = {};
  const payload: Record<string, unknown> = {};
  for (const run of sorted) {
    const label = runLabel(run);
    const canonical = canonicalize(run.stats);
    payload[label] = canonical;
    runHashes[label] = sha256(JSON.stringify(canonical));
  }

  return {
    version: FINGERPRINT_VERSION,
    runs: sorted.map(runLabel),
    hash: sha256(JSON.stringify(runHashes)),
    runHashes,
    payload,
  };
}

export interface FieldDrift {
  /** Dotted path into `RunStats`, e.g. `combat.totalKills`. */
  path: string;
  baseline: unknown;
  current: unknown;
}

export interface RunDrift {
  label: string;
  /** `missing` = absent from current, `added` = absent from baseline. */
  kind: 'changed' | 'missing' | 'added';
  fields: FieldDrift[];
}

export interface FingerprintComparison {
  identical: boolean;
  /** Set when the two fingerprints were produced by different canonicalizers. */
  versionMismatch: boolean;
  drifts: RunDrift[];
}

function diffValues(baseline: unknown, current: unknown, path: string, out: FieldDrift[]): void {
  if (JSON.stringify(baseline) === JSON.stringify(current)) {
    return;
  }
  const bothPlainObjects =
    baseline !== null &&
    current !== null &&
    typeof baseline === 'object' &&
    typeof current === 'object' &&
    !Array.isArray(baseline) &&
    !Array.isArray(current);

  if (!bothPlainObjects) {
    out.push({ path, baseline, current });
    return;
  }

  const b = baseline as Record<string, unknown>;
  const c = current as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(c)])].sort()) {
    diffValues(b[key], c[key], path === '' ? key : `${path}.${key}`, out);
  }
}

/**
 * Compare a stored baseline fingerprint against a freshly measured one and
 * report every divergent field. A version mismatch is always reported as drift
 * — a stale baseline must be regenerated rather than silently trusted.
 */
export function compareFingerprints(
  baseline: Fingerprint,
  current: Fingerprint,
): FingerprintComparison {
  const versionMismatch = baseline.version !== current.version;
  if (versionMismatch) {
    return { identical: false, versionMismatch, drifts: [] };
  }

  const drifts: RunDrift[] = [];
  const labels = [
    ...new Set([...Object.keys(baseline.runHashes), ...Object.keys(current.runHashes)]),
  ].sort();

  for (const label of labels) {
    const inBaseline = label in baseline.runHashes;
    const inCurrent = label in current.runHashes;
    if (!inCurrent) {
      drifts.push({ label, kind: 'missing', fields: [] });
      continue;
    }
    if (!inBaseline) {
      drifts.push({ label, kind: 'added', fields: [] });
      continue;
    }
    if (baseline.runHashes[label] === current.runHashes[label]) {
      continue;
    }
    const fields: FieldDrift[] = [];
    diffValues(baseline.payload[label], current.payload[label], '', fields);
    drifts.push({ label, kind: 'changed', fields });
  }

  return { identical: drifts.length === 0, versionMismatch, drifts };
}

/** Render a comparison as a human-readable report for CLI output / PR bodies. */
export function formatComparison(comparison: FingerprintComparison, maxFields = 12): string {
  if (comparison.versionMismatch) {
    return 'Fingerprint schema version mismatch — regenerate the baseline with `npm run perf:fingerprint -- --write <file>`.';
  }
  if (comparison.identical) {
    return 'Gameplay identical: every run matches the baseline byte-for-byte.';
  }
  const lines: string[] = [`Gameplay DRIFT in ${comparison.drifts.length} run(s):`];
  for (const drift of comparison.drifts) {
    if (drift.kind !== 'changed') {
      lines.push(`  ${drift.label} — ${drift.kind} from the compared fingerprint`);
      continue;
    }
    lines.push(`  ${drift.label}`);
    for (const field of drift.fields.slice(0, maxFields)) {
      lines.push(
        `    ${field.path}: ${JSON.stringify(field.baseline)} → ${JSON.stringify(field.current)}`,
      );
    }
    if (drift.fields.length > maxFields) {
      lines.push(`    …and ${drift.fields.length - maxFields} more field(s)`);
    }
  }
  return lines.join('\n');
}
