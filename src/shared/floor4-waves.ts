/**
 * Floor 4 wave manifests — the pure, seeded half of the arena's wave machinery.
 *
 * Everything here is a pure function of (authored config, floor seed, act, wave
 * index). Nothing reads world state, nothing reads the clock, and nothing
 * touches `world.rng`: each wave draws from its OWN derived stream
 * (`<seed>:floor4:waves:<act>:<waveIndex>`, spec FR7.1/FR7.2), so a manifest is
 * byte-identical no matter how the run before it went — cap pressure, spawn
 * debt, frame timing and player skill cannot perturb it (FR7.4).
 *
 * The director in `src/game/floor4Scenario.ts` owns *when* these manifests
 * release and *whether* an entry fits under the live cap. It never re-rolls
 * one.
 */
import { SeededRandom, hashStringToSeed } from './random.js';
import type { Floor4ActIndex, Floor4WaveManifest, Floor4WaveSpawnEntry } from './floor-types.js';

/** One authored roster entry: an archetype with its act-scoped cost/weight. */
export interface Floor4WaveRosterEntry {
  readonly archetypeId: string;
  readonly threatCost: number;
  readonly weight: number;
}

/** Authored wave schedule config (the manifest's `floor4.waves` block). */
export interface Floor4WaveScheduleConfig {
  readonly enemyPackId: string;
  readonly cadence: { readonly wavesPerAct: number; readonly intervalMs: number };
  readonly budget: {
    readonly base: number;
    readonly actMultipliers: readonly number[];
    readonly intraActRamp: number;
    readonly openingWaveMultiplier: number;
    readonly maxEntriesPerWave: number;
  };
  readonly concurrency: { readonly liveCap: number; readonly debtCap: number };
  readonly gates: { readonly telegraphLeadMs: number };
  readonly rosters: readonly {
    readonly act: number;
    readonly entries: readonly Floor4WaveRosterEntry[];
  }[];
}

/**
 * Canonical stream key for a wave manifest (spec FR7.1/FR7.2).
 *
 * The `:` delimiter and the `waves` purpose label are a data contract: changing
 * either re-rolls every existing seed's card, which is a breaking change.
 */
export function floor4WaveStreamKey(seed: number, act: number, waveIndex: number): string {
  return `${seed}:floor4:waves:${act}:${waveIndex}`;
}

/** Act-relative release mark for a wave, in ms (spec FR3.1). */
export function floor4WaveReleaseAtActMs(
  config: Floor4WaveScheduleConfig,
  waveIndex: number,
): number {
  return waveIndex * config.cadence.intervalMs;
}

/**
 * FR3.3 budget curve:
 * `baseBudget × actMultiplier[act] × (1 + intraActRamp × waveIndex)`.
 *
 * Act 1's wave 0 additionally takes `openingWaveMultiplier` — the deliberately
 * tiny opener that teaches the gates before the floor means it (design §5.1).
 */
export function computeFloor4WaveBudget(
  config: Floor4WaveScheduleConfig,
  act: number,
  waveIndex: number,
): number {
  const actMultiplier = config.budget.actMultipliers[act - 1];
  if (actMultiplier === undefined) {
    throw new Error(`Floor 4 wave budget: no act multiplier authored for act ${act}`);
  }
  const base = config.budget.base * actMultiplier * (1 + config.budget.intraActRamp * waveIndex);
  return act === 1 && waveIndex === 0 ? base * config.budget.openingWaveMultiplier : base;
}

/** The authored roster for an act. Throws rather than silently spawning nothing. */
export function floor4ActRoster(
  config: Floor4WaveScheduleConfig,
  act: number,
): readonly Floor4WaveRosterEntry[] {
  const roster = config.rosters.find((candidate) => candidate.act === act);
  if (!roster || roster.entries.length === 0) {
    throw new Error(`Floor 4 wave roster missing for act ${act}`);
  }
  return roster.entries;
}

/**
 * Weighted pick over an already-filtered candidate list. Consumes exactly ONE
 * draw per call so the stream position stays a simple function of the entries
 * emitted so far.
 */
function pickWeighted(
  rng: SeededRandom,
  candidates: readonly Floor4WaveRosterEntry[],
): Floor4WaveRosterEntry {
  let totalWeight = 0;
  for (const candidate of candidates) {
    totalWeight += candidate.weight;
  }
  let roll = rng.next() * totalWeight;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll < 0) {
      return candidate;
    }
  }
  // Floating-point tail: the last candidate is the only one it can be.
  return candidates[candidates.length - 1]!;
}

/**
 * Compose one wave's immutable manifest.
 *
 * Spends the wave's threat budget on roster archetypes, assigning each entry a
 * fixed feed-gate index. Both draws come from the wave's own stream, so entry
 * order — which is also the spawn order and the FIFO debt order — is a pure
 * function of the seed.
 */
export function buildFloor4WaveManifest(
  config: Floor4WaveScheduleConfig,
  seed: number,
  act: Floor4ActIndex,
  waveIndex: number,
  gateCount: number,
): Floor4WaveManifest {
  if (gateCount <= 0) {
    throw new Error('Floor 4 wave manifest requires at least one feed gate');
  }
  const roster = floor4ActRoster(config, act);
  const budget = computeFloor4WaveBudget(config, act, waveIndex);
  const rng = new SeededRandom(hashStringToSeed(floor4WaveStreamKey(seed, act, waveIndex)));

  const entries: Floor4WaveSpawnEntry[] = [];
  let remaining = budget;
  while (entries.length < config.budget.maxEntriesPerWave) {
    const affordable = roster.filter((candidate) => candidate.threatCost <= remaining);
    if (affordable.length === 0) {
      break;
    }
    const picked = pickWeighted(rng, affordable);
    const gateIndex = rng.nextInt(0, gateCount - 1);
    entries.push({ archetypeId: picked.archetypeId, gateIndex, threatCost: picked.threatCost });
    remaining -= picked.threatCost;
  }

  return Object.freeze({
    act,
    waveIndex,
    releaseAtActMs: floor4WaveReleaseAtActMs(config, waveIndex),
    budget,
    entries: Object.freeze(entries),
  });
}

/**
 * Build every wave manifest for an act. Called once when the act's wave window
 * opens (FR3.2); the result is frozen and never recomputed for that act.
 */
export function buildFloor4ActWaveManifests(
  config: Floor4WaveScheduleConfig,
  seed: number,
  act: Floor4ActIndex,
  gateCount: number,
): readonly Floor4WaveManifest[] {
  const manifests: Floor4WaveManifest[] = [];
  for (let waveIndex = 0; waveIndex < config.cadence.wavesPerAct; waveIndex += 1) {
    manifests.push(buildFloor4WaveManifest(config, seed, act, waveIndex, gateCount));
  }
  return Object.freeze(manifests);
}
