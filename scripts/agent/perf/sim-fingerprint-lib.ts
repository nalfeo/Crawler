/**
 * Pure helpers behind the deterministic gameplay fingerprint.
 *
 * The fingerprint exists to answer one question for the **perf-optimizer**
 * workflow: *did this change perturb the headless simulation?* It hashes the
 * full `RunStats` of the Floor-1 gate sample so a before/after comparison is a
 * mechanical check rather than a judgement call.
 *
 * ## What it does and does not cover
 *
 * `RunStats` is end-of-run telemetry — outcome, aggregates, quest/level events.
 * An identical hash therefore proves the covered runs produced identical
 * **reported results**, which in practice is a very strong signal that the RNG
 * stream and the simulation were untouched. It is *not* a full world-state
 * trace: a divergence that reconverges before run end without moving any
 * reported field could slip through. And it says nothing at all about
 * rendering, asset loading, input, or browser behavior — none of which the
 * headless pipeline exercises. Render/load work needs its own observation on
 * top of this.
 *
 * Everything here is pure and synchronous so it can be unit-tested without
 * running the (multi-minute) headless sample.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../src/shared/canonical-json.js';

/**
 * Exact top-level `RunStats` keys excluded from the fingerprint because they
 * are wall-clock measurements — the one thing an optimization is *supposed* to
 * change.
 *
 * This is a deliberate **allowlist of exact keys**, not a name pattern. A
 * pattern would silently drop a future gameplay field that happened to match,
 * and would silently *fail* to drop a future timing field that didn't. With an
 * allowlist, adding a new non-deterministic field to `RunStats` breaks the gate
 * loudly on the next run — the correct direction to fail. Add the key here,
 * deliberately, when that happens.
 */
export const NON_DETERMINISTIC_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['wallTimeMs']);

export interface FingerprintRunKey {
  weapon: string;
  seed: number;
}

export interface FingerprintRun extends FingerprintRunKey {
  /** Raw `RunStats` for this (weapon, seed) pair. */
  stats: unknown;
}

/**
 * The workload a fingerprint was measured over, so two fingerprints can only be
 * compared when they describe the same thing.
 */
export interface FingerprintSample {
  seeds: number[];
  weapons: string[];
  maxFrames: number;
}

export interface Fingerprint {
  /** Schema version so a canonicalization change invalidates stale baselines. */
  version: number;
  /** The workload this fingerprint covers. */
  sample: FingerprintSample;
  /** Sorted `weapon:seed` labels covered by this fingerprint. */
  runs: string[];
  /** sha256 over the canonical JSON of every run, in sorted order. */
  hash: string;
  /** Per-run hash, so a drift report can name the exact divergent runs. */
  runHashes: Record<string, string>;
  /** Canonical per-run payload, retained so drift can be diffed field-by-field. */
  payload: Record<string, unknown>;
}

export const FINGERPRINT_VERSION = 2;

export function runLabel(key: FingerprintRunKey): string {
  return `${key.weapon}:${key.seed}`;
}

/**
 * Recursively rebuild a value with object keys sorted, so `JSON.stringify`
 * yields a stable byte sequence regardless of property insertion order.
 *
 * Throws on any value `JSON.stringify` would silently flatten into an
 * indistinguishable token — a non-finite number (`NaN` and `±Infinity` all
 * become `null`) or a `Map`/`Set` (no own enumerable keys, so every instance
 * becomes `{}` regardless of contents). Silently collapsing those would let
 * genuinely different simulations share a hash, which is the one failure
 * direction this tool must never have.
 */
export function canonicalize(value: unknown, path = ''): unknown {
  if (Array.isArray(value)) {
    // Array.from (not .map) so sparse holes are visited and normalized rather
    // than surviving as holes.
    return Array.from(value, (entry, index) =>
      entry === undefined ? null : canonicalize(entry, `${path}[${index}]`),
    );
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Non-finite number at "${path === '' ? '<root>' : path}": ${String(value)}. ` +
          'JSON collapses NaN and ±Infinity to the same token, so it cannot be fingerprinted — ' +
          'a non-finite RunStats field means the simulation itself has a bug to fix first.',
      );
    }
    // -0 and 0 stringify identically but are distinct via Object.is; normalize
    // so a sign-of-zero flip can never masquerade as drift.
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Map || value instanceof Set) {
    throw new Error(
      `Unsupported ${value instanceof Map ? 'Map' : 'Set'} at "${path === '' ? '<root>' : path}". ` +
        'These have no own enumerable keys, so every instance would canonicalize to {} and share ' +
        'a hash. Convert to a plain object or array before fingerprinting.',
    );
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    // Same collision class as Map/Set, generalized: Date, RegExp, Error and any
    // class instance expose no (or partial) enumerable own keys, so distinct
    // values would canonicalize to the same object and share a hash. Reject
    // structurally rather than blacklisting types one at a time.
    throw new Error(
      `Unsupported non-plain object (${(value as object).constructor?.name ?? 'unknown'}) at ` +
        `"${path === '' ? '<root>' : path}". Its own enumerable keys do not capture its value, so ` +
        'distinct instances could share a hash. Serialize it to a plain object, array, or ' +
        'primitive before fingerprinting.',
    );
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) {
      continue;
    }
    result[key] = canonicalize(entry, path === '' ? key : `${path}.${key}`);
  }
  return result;
}

/**
 * Strip the wall-clock keys, then canonicalize. Only **top-level** keys are
 * eligible — see {@link NON_DETERMINISTIC_TOP_LEVEL_KEYS}.
 */
function canonicalizeStats(stats: unknown, label: string): unknown {
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) {
    return canonicalize(stats, label);
  }
  const source = stats as Record<string, unknown>;
  const retained: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (NON_DETERMINISTIC_TOP_LEVEL_KEYS.has(key)) {
      continue;
    }
    retained[key] = source[key];
  }
  return canonicalize(retained, label);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalString(value: unknown): string {
  return canonicalJson(value);
}

function normalizeSample(sample: FingerprintSample): FingerprintSample {
  return {
    seeds: [...sample.seeds].sort((a, b) => a - b),
    weapons: [...sample.weapons].sort(),
    maxFrames: sample.maxFrames,
  };
}

/**
 * Build a fingerprint over a set of completed runs. Run order is normalized, so
 * a parallel sweep and a sequential sweep produce the same fingerprint.
 */
export function buildFingerprint(
  runs: readonly FingerprintRun[],
  sample: FingerprintSample,
): Fingerprint {
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
    const canonical = canonicalizeStats(run.stats, label);
    payload[label] = canonical;
    runHashes[label] = sha256(canonicalString(canonical));
  }

  return {
    version: FINGERPRINT_VERSION,
    sample: normalizeSample(sample),
    runs: sorted.map(runLabel),
    hash: sha256(canonicalString(runHashes)),
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
  /**
   * Set when the two fingerprints cover different workloads. Comparing them is
   * meaningless, so this is reported *instead of* per-run drift — otherwise a
   * narrowed `--check` reports every uncovered baseline run as "drift" and
   * sends the reader hunting for a nonexistent gameplay bug.
   */
  sampleMismatch: string | null;
  drifts: RunDrift[];
}

function describeSample(sample: FingerprintSample | undefined): string {
  if (sample === undefined) {
    return 'unknown';
  }
  return `seeds [${sample.seeds.join(',')}] × [${sample.weapons.join(',')}] @ ${sample.maxFrames} frames`;
}

function sampleMismatchReason(baseline: Fingerprint, current: Fingerprint): string | null {
  const a = baseline.sample as FingerprintSample | undefined;
  const b = current.sample as FingerprintSample | undefined;
  if (a === undefined || b === undefined) {
    return 'one fingerprint has no recorded sample metadata (regenerate the baseline)';
  }
  if (JSON.stringify(normalizeSample(a)) === JSON.stringify(normalizeSample(b))) {
    return null;
  }
  return `baseline covers ${describeSample(a)}; current covers ${describeSample(b)}`;
}

function diffValues(baseline: unknown, current: unknown, path: string, out: FieldDrift[]): void {
  if (Object.is(baseline, current)) {
    return;
  }
  if (Array.isArray(baseline) && Array.isArray(current)) {
    if (baseline.length !== current.length) {
      out.push({
        path: path === '' ? 'length' : `${path}.length`,
        baseline: baseline.length,
        current: current.length,
      });
    }
    for (let index = 0; index < Math.max(baseline.length, current.length); index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= baseline.length) {
        out.push({ path: childPath, baseline: undefined, current: current[index] });
        continue;
      }
      if (index >= current.length) {
        out.push({ path: childPath, baseline: baseline[index], current: undefined });
        continue;
      }
      diffValues(baseline[index], current[index], childPath, out);
    }
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
 * report every divergent field.
 *
 * A schema-version mismatch or a differing sample is always reported as a
 * non-identical result: a stale or non-comparable baseline must be regenerated
 * rather than silently trusted.
 */
export function compareFingerprints(
  baseline: Fingerprint,
  current: Fingerprint,
): FingerprintComparison {
  const versionMismatch = baseline.version !== current.version;
  if (versionMismatch) {
    return { identical: false, versionMismatch, sampleMismatch: null, drifts: [] };
  }

  const sampleMismatch = sampleMismatchReason(baseline, current);
  if (sampleMismatch !== null) {
    return { identical: false, versionMismatch: false, sampleMismatch, drifts: [] };
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

  return { identical: drifts.length === 0, versionMismatch: false, sampleMismatch: null, drifts };
}

/** Render a comparison as a human-readable report for CLI output / PR bodies. */
export function formatComparison(comparison: FingerprintComparison, maxFields = 12): string {
  if (comparison.versionMismatch) {
    return 'Fingerprint schema version mismatch — regenerate the baseline with `npm run perf:fingerprint -- --write <file>`.';
  }
  if (comparison.sampleMismatch !== null) {
    return (
      'Sample mismatch — these fingerprints cover different workloads and cannot be compared:\n' +
      `  ${comparison.sampleMismatch}\n` +
      'Re-run --check with the same --seeds/--weapons/--max-frames the baseline used. This is NOT a gameplay finding.'
    );
  }
  if (comparison.identical) {
    return 'RunStats identical: every run in the sample matches the baseline byte-for-byte.';
  }
  const lines: string[] = [`RunStats DRIFT in ${comparison.drifts.length} run(s):`];
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
