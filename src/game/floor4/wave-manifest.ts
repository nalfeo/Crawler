/**
 * Floor 4 — deterministic wave manifests (spec R3/R7).
 *
 * A wave manifest is an **immutable, seeded plan**: every wave of an act is
 * rolled once when the act arms, from a stream derived only from
 * `(floorSeed, act, waveIndex)`. Nothing the player does can re-roll it, and
 * nothing the director does at release time consumes RNG — so two runs of the
 * same seed schedule byte-identical waves regardless of how the fight goes
 * (FR7.1/FR7.2).
 *
 * This module is intentionally pure: no `GameWorld`, no ECS, no clock. It takes
 * config plus the per-gate slot counts and returns plain data, which is what
 * makes the scheduling directly unit-testable.
 */
import { SeededRandom, hashStringToSeed } from '../../shared/random.js';
import type {
  Floor4ActIndex,
  Floor4WaveManifest,
  Floor4WaveSpawn,
} from '../../shared/floor-types.js';

/** The subset of the manifest `floor4.waves` block manifest generation needs. */
interface Floor4WaveConfig {
  readonly wavesPerAct: number;
  readonly waveIntervalMs: number;
  readonly gateTelegraphMs: number;
  readonly baseBudget: number;
  readonly intraActRamp: number;
  readonly openingWaveBudgetScale: number;
  readonly actMultipliers: readonly number[];
  readonly acts: ReadonlyArray<{
    readonly act: number;
    readonly roster: ReadonlyArray<{ readonly archetypeId: string; readonly threatCost: number }>;
  }>;
}

/**
 * Threat budget for one wave (spec FR3.3). Rounded to a positive integer so the
 * spend loop below works in whole threat units and can never drift by a
 * floating-point epsilon.
 */
function floor4WaveBudget(
  config: Floor4WaveConfig,
  act: Floor4ActIndex,
  waveIndex: number,
): number {
  const multiplier = config.actMultipliers[act - 1] ?? 1;
  // The opener is deliberately tiny: act 1 wave 0 lands the instant the
  // countdown ends and is the player's first read of the arena.
  const openingScale = act === 1 && waveIndex === 0 ? config.openingWaveBudgetScale : 1;
  const raw = config.baseBudget * multiplier * openingScale * (1 + config.intraActRamp * waveIndex);
  return Math.max(1, Math.round(raw));
}

/**
 * Build every wave manifest for one act.
 *
 * `gateSlotCounts[gateIndex]` is how many validated spawn slots that gate has;
 * it is passed in (rather than read from the map) to keep this pure. Gates with
 * no usable slot are skipped, which cannot happen in the authored venue but
 * keeps the roll total-safe.
 *
 * Termination invariant: `threatCost` is a validated positive integer and each
 * iteration picks only from the *affordable* subset, so `remaining` strictly
 * decreases and the loop always ends.
 */
export function buildFloor4ActWaveManifests(
  config: Floor4WaveConfig,
  act: Floor4ActIndex,
  floorSeed: number | string,
  gateSlotCounts: readonly number[],
): readonly Floor4WaveManifest[] {
  const actRow = config.acts.find((row) => row.act === act);
  if (!actRow) {
    throw new Error(`Floor 4 wave config has no roster for act ${act}`);
  }
  const usableGates = gateSlotCounts
    .map((count, gateIndex) => ({ count, gateIndex }))
    .filter((gate) => gate.count > 0);
  if (usableGates.length === 0) {
    throw new Error('Floor 4 wave manifests need at least one feed gate with a usable spawn slot');
  }

  const manifests: Floor4WaveManifest[] = [];
  for (let waveIndex = 0; waveIndex < config.wavesPerAct; waveIndex += 1) {
    const rng = new SeededRandom(
      hashStringToSeed(
        [String(floorSeed), 'floor4', 'waves', String(act), String(waveIndex)].join(':'),
      ),
    );
    const budget = floor4WaveBudget(config, act, waveIndex);
    const spawns: Floor4WaveSpawn[] = [];
    let remaining = budget;
    for (;;) {
      const affordable = actRow.roster.filter((entry) => entry.threatCost <= remaining);
      if (affordable.length === 0) {
        break;
      }
      const pick = affordable[rng.nextInt(0, affordable.length - 1)];
      const gate = usableGates[rng.nextInt(0, usableGates.length - 1)];
      if (!pick || !gate) {
        break;
      }
      spawns.push({
        archetypeId: pick.archetypeId,
        gateIndex: gate.gateIndex,
        slotIndex: rng.nextInt(0, gate.count - 1),
        threatCost: pick.threatCost,
      });
      remaining -= pick.threatCost;
    }
    const releaseAtMs = waveIndex * config.waveIntervalMs;
    manifests.push({
      act,
      waveIndex,
      releaseAtMs,
      // Wave 0 releases at act-relative t=0, so there is no room ahead of it to
      // telegraph into: its flare coincides with the release instead of being
      // scheduled at a negative arena time that could never fire.
      telegraphAtMs: Math.max(0, releaseAtMs - config.gateTelegraphMs),
      budget,
      spawns,
    });
  }
  return manifests;
}

/**
 * Compact, order-sensitive fingerprint of an act's manifests. Lets a
 * determinism test compare two runs of a seed without serializing every spawn
 * into the RunStats payload.
 */
export function floor4WaveManifestFingerprint(manifests: readonly Floor4WaveManifest[]): string {
  const body = manifests
    .map(
      (wave) =>
        `${wave.waveIndex}@${wave.releaseAtMs}#${wave.budget}:` +
        wave.spawns.map((s) => `${s.archetypeId}/${s.gateIndex}/${s.slotIndex}`).join(','),
    )
    .join('|');
  return `${manifests[0]?.act ?? 0}~${hashStringToSeed(body).toString(36)}`;
}
