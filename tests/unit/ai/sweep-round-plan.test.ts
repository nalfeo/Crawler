/**
 * Unit coverage for the cloud eval pipeline's PURE round-planning +
 * checkpointing module (`scripts/agent/perf/round-plan.ts`).
 *
 * This module is the actual fix for the 2026-07 timing blowup (run
 * 29606086471, cancelled after ~3h40 with zero artifacts): it turns one
 * round's candidates × weapons × seeds into an independently-schedulable
 * matrix job PER CANDIDATE, and folds a round's results back into a
 * `RoundCheckpoint` that is a complete, self-contained artifact — so a
 * downstream timeout or partial matrix failure never discards a prior
 * round's progress. Its invariants are locked here:
 *   - `initCheckpoint` builds a valid round-0 state from exactly one baseline
 *     config, seeds `incumbentConfigId` to that baseline id (never reassigned
 *     across rounds), and refuses an ambiguous/empty baseline shard;
 *   - `planCandidates`/`planRoundMatrix` only emit genuinely NEW, in-range
 *     neighbours, flatten cleanly across combos, respect the matrix cardinality
 *     cap, and emit nothing once a combo has converged;
 *   - `applyRoundResult` promotes only a candidate that BOTH out-scores the
 *     current best AND passes the same hard safety gate that governs final
 *     graduation (>=90% official wins AND zero win→loss flips vs the
 *     incumbent) — a higher-scoring candidate that flips an incumbent win
 *     must never be promoted (this is the fix for the real bug the 2026-07
 *     untuned graduation run, GH run 29597840666, exposed: 292/300-win
 *     candidates with 5 flips each were previously indistinguishable from a
 *     safe improvement by score alone);
 *   - otherwise it halves step sizes toward convergence — UNLESS the caller
 *     supplies `plannedCount` and some of this round's planned candidates
 *     never produced a shard at all (an infra failure, not a search
 *     dead-end), in which case steps/converged are left untouched so the same
 *     neighbours are retried next round instead of the search falsely
 *     "learning" there's no improvement from partial data;
 *   - a converged checkpoint is a no-op under `applyRoundResult` (idempotent);
 *   - conflicting config definitions and cross-shard duplicate rows are
 *     handled exactly like the legacy `mergeShards` determinism contract;
 *   - `toSearchArtifact` is a lossless-for-`validate` pure projection.
 */
import { describe, expect, it } from 'vitest';
import {
  applyRoundResult,
  halveSteps,
  initCheckpoint,
  planCandidates,
  planRoundMatrix,
  toSearchArtifact,
  type CheckpointWithKnobs,
  type RoundCheckpoint,
} from '../../../scripts/agent/perf/round-plan.js';
import {
  baseConfigForCombo,
  configId,
  type Combo,
  type SweepConfig,
  type TunableKnob,
} from '../../../scripts/agent/perf/gen-configs.js';
import {
  SHARD_SCHEMA_VERSION,
  type RunRow,
  type ShardArtifact,
  type ShardMeta,
} from '../../../scripts/agent/perf/aggregate-shards.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';

const LEGACY_LEGACY: Combo = {
  pathing: AIPathingMode.LEGACY,
  decision: AIDecisionMode.LEGACY,
};
// A non-legacy combo for incumbent-mismatch tests.
const NAVMESH_LEGACY: Combo = {
  pathing: AIPathingMode.NAVMESH_FUSED,
  decision: AIDecisionMode.LEGACY,
};
const KNOBS: TunableKnob[] = ['aggression'];

const META: ShardMeta = {
  schemaVersion: SHARD_SCHEMA_VERSION,
  budgetMs: 360_000,
  floorId: 'floor1',
  maxFrames: 23_760,
  stage: 'search',
  runnerOs: 'linux',
  nodeVersion: 'v22.0.0',
  packageLockHash: 'abc123def456abc123def456',
  workflowSha: 'deadbeefcafe0000deadbeefcafe0000',
};

const BASE: SweepConfig = baseConfigForCombo(LEGACY_LEGACY); // aggression: 1
const BASE_ID = configId(BASE);

function row(
  configIdValue: string,
  weapon: string,
  seed: number,
  score: number,
  win = true,
): RunRow {
  return {
    combo: 'legacy+legacy',
    configId: configIdValue,
    weapon,
    seed,
    outcome: win ? 'victory' : 'death',
    officialWin: win,
    gameTimeMs: 100_000, // well under META.budgetMs so `victory` recomputes as an official win
    safeRoomMs: 0,
    score,
    xp: 100,
    gold: 50,
    minHealthPercent: 0.5,
    finalLevel: 5,
  };
}

function shard(rows: RunRow[], configs: Record<string, SweepConfig>): ShardArtifact {
  return { meta: { ...META }, configs, rows };
}

function baselineShard(score = 100): ShardArtifact {
  return shard([row(BASE_ID, 'sword', 1, score)], { [BASE_ID]: BASE });
}

function baseCheckpoint(score = 100): RoundCheckpoint {
  return initCheckpoint(LEGACY_LEGACY, KNOBS, baselineShard(score));
}

describe('initCheckpoint', () => {
  it('builds a round-0 checkpoint seeded from the baseline shard', () => {
    const checkpoint = baseCheckpoint(150);
    expect(checkpoint.combo).toBe('legacy+legacy');
    expect(checkpoint.round).toBe(0);
    expect(checkpoint.bestConfigId).toBe(BASE_ID);
    expect(checkpoint.bestScore).toBe(150);
    expect(checkpoint.incumbentConfigId).toBe(BASE_ID);
    expect(checkpoint.converged).toBe(false);
    expect(checkpoint.steps.aggression).toBe(0.5); // rangeFor('aggression').step
    expect(checkpoint.configs).toEqual({ [BASE_ID]: BASE });
    expect(checkpoint.rows).toHaveLength(1);
  });

  it('throws when the baseline shard has zero configs', () => {
    expect(() => initCheckpoint(LEGACY_LEGACY, KNOBS, shard([], {}))).toThrow(
      /must contain exactly one config, got 0/,
    );
  });

  it('throws when the baseline shard has more than one config (ambiguous)', () => {
    const other: SweepConfig = { ...BASE, aggression: 1.5 };
    const bad = shard([row(BASE_ID, 'sword', 1, 100)], {
      [BASE_ID]: BASE,
      [configId(other)]: other,
    });
    expect(() => initCheckpoint(LEGACY_LEGACY, KNOBS, bad)).toThrow(
      /must contain exactly one config, got 2/,
    );
  });

  it("uses the combo's own base as incumbent when no legacyBaseline is provided (legacy+legacy or smoke runs)", () => {
    const checkpoint = baseCheckpoint(150);
    expect(checkpoint.incumbentConfigId).toBe(BASE_ID);
  });

  it('uses the LEGACY incumbent from legacyBaseline for a non-LEGACY combo, seeding the safety gate correctly', () => {
    // For a non-LEGACY combo (navmeshFused+legacy), the combo's own base config
    // would be a wrong reference for the flip check — the graduation gate always
    // uses legacy+legacy as the incumbent. Providing legacyBaseline fixes this.
    const navmeshBase: SweepConfig = baseConfigForCombo(NAVMESH_LEGACY);
    const navmeshBaseId = configId(navmeshBase);
    const navmeshBaselineShard = shard([row(navmeshBaseId, 'sword', 1, 100)], {
      [navmeshBaseId]: navmeshBase,
    });
    const legacyBaselineShard = baselineShard(80); // LEGACY config

    const checkpoint = initCheckpoint(NAVMESH_LEGACY, KNOBS, navmeshBaselineShard, legacyBaselineShard);
    // bestConfigId is the combo's own base (navmesh), not the LEGACY incumbent.
    expect(checkpoint.bestConfigId).toBe(navmeshBaseId);
    // incumbentConfigId is the LEGACY config — matches the graduation gate.
    expect(checkpoint.incumbentConfigId).toBe(BASE_ID);
    // Both configs and both sets of rows are merged in.
    expect(Object.keys(checkpoint.configs)).toContain(navmeshBaseId);
    expect(Object.keys(checkpoint.configs)).toContain(BASE_ID);
  });

  it('throws when legacyBaseline contains more than one config (ambiguous)', () => {
    const navmeshBase: SweepConfig = baseConfigForCombo(NAVMESH_LEGACY);
    const navmeshBaseId = configId(navmeshBase);
    const navmeshBaselineShard = shard([row(navmeshBaseId, 'sword', 1, 100)], {
      [navmeshBaseId]: navmeshBase,
    });
    const other: SweepConfig = { ...BASE, aggression: 1.5 };
    const badLegacy = shard([row(BASE_ID, 'sword', 1, 100)], {
      [BASE_ID]: BASE,
      [configId(other)]: other,
    });
    expect(() => initCheckpoint(NAVMESH_LEGACY, KNOBS, navmeshBaselineShard, badLegacy)).toThrow(
      /legacyBaseline shard must contain exactly one config, got 2/,
    );
  });
});

describe('planCandidates', () => {
  it('emits the ±step neighbours of the current best, none yet evaluated', () => {
    const checkpoint = baseCheckpoint();
    const candidates = planCandidates(checkpoint, KNOBS);
    const values = candidates.map((c) => c.config.aggression).sort();
    expect(values).toEqual([0.5, 1.5]); // 1 ± step(0.5), matches neighbors() unit coverage
  });

  it('filters out neighbours already evaluated in an earlier round', () => {
    const checkpoint = baseCheckpoint();
    const [already] = planCandidates(checkpoint, KNOBS);
    // Simulate a prior round having already visited this neighbour.
    const withVisited: RoundCheckpoint = {
      ...checkpoint,
      configs: { ...checkpoint.configs, [already!.id]: already!.config },
    };
    const remaining = planCandidates(withVisited, KNOBS);
    expect(remaining).toHaveLength(1);
    expect(remaining.map((c) => c.id)).not.toContain(already!.id);
  });

  it('returns nothing once the checkpoint has converged', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(), converged: true };
    expect(planCandidates(checkpoint, KNOBS)).toEqual([]);
  });

  it('throws when bestConfigId is missing from configs (corrupt checkpoint)', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(), bestConfigId: 'no-such-id' };
    expect(() => planCandidates(checkpoint, KNOBS)).toThrow(/missing config for bestConfigId/);
  });
});

describe('planRoundMatrix', () => {
  it('flattens every open combo’s candidates into one matrix-ready list, tagged by combo', () => {
    const checkpoints: CheckpointWithKnobs[] = [
      { checkpoint: { ...baseCheckpoint(), combo: 'legacy+legacy' }, knobs: KNOBS },
      { checkpoint: { ...baseCheckpoint(), combo: 'navmeshFused+legacy' }, knobs: KNOBS },
    ];
    const matrix = planRoundMatrix(checkpoints);
    expect(matrix).toHaveLength(4); // 2 candidates x 2 combos
    expect(new Set(matrix.map((c) => c.combo))).toEqual(
      new Set(['legacy+legacy', 'navmeshFused+legacy']),
    );
    for (const c of matrix) {
      expect(c).toHaveProperty('configId');
      expect(c).toHaveProperty('config');
    }
  });

  it('omits a converged combo entirely (no candidates emitted for it)', () => {
    const checkpoints: CheckpointWithKnobs[] = [
      { checkpoint: { ...baseCheckpoint(), converged: true }, knobs: KNOBS },
    ];
    expect(planRoundMatrix(checkpoints)).toEqual([]);
  });

  it('does not invoke the cardinality guard at all when nothing is open (cap=0 never throws)', () => {
    const checkpoints: CheckpointWithKnobs[] = [
      { checkpoint: { ...baseCheckpoint(), converged: true }, knobs: KNOBS },
    ];
    expect(() => planRoundMatrix(checkpoints, 0)).not.toThrow();
  });

  it('hard-fails BEFORE any runner spins up when the flattened matrix exceeds the cap', () => {
    const checkpoints: CheckpointWithKnobs[] = [
      { checkpoint: { ...baseCheckpoint(), combo: 'legacy+legacy' }, knobs: KNOBS },
      { checkpoint: { ...baseCheckpoint(), combo: 'navmeshFused+legacy' }, knobs: KNOBS },
    ];
    // 4 total candidates, cap 3 -> must throw the same cardinality-guard message.
    expect(() => planRoundMatrix(checkpoints, 3)).toThrow(/exceeding the safe cap of 3/);
  });
});

describe('applyRoundResult', () => {
  it('adopts a genuinely improving candidate as the new best, leaving steps untouched', () => {
    const checkpoint = baseCheckpoint(100);
    const better: SweepConfig = { ...BASE, aggression: 1.5 };
    const betterId = configId(better);
    const candidateShard = shard([row(betterId, 'sword', 1, 500)], { [betterId]: better });
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [candidateShard]);
    expect(updated.bestConfigId).toBe(betterId);
    expect(updated.bestScore).toBe(500);
    expect(updated.round).toBe(1);
    expect(updated.steps.aggression).toBe(0.5); // unchanged on improvement
    expect(updated.converged).toBe(false);
    // Prior + new rows/configs both retained.
    expect(updated.rows).toHaveLength(2);
    expect(Object.keys(updated.configs).sort()).toEqual([BASE_ID, betterId].sort());
  });

  it('halves step sizes when nothing in the round improves on the current best', () => {
    const checkpoint = baseCheckpoint(500); // baseline already high-scoring
    const worse: SweepConfig = { ...BASE, aggression: 1.5 };
    const worseId = configId(worse);
    const candidateShard = shard([row(worseId, 'sword', 1, 10)], { [worseId]: worse });
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [candidateShard]);
    expect(updated.bestConfigId).toBe(BASE_ID); // unchanged
    expect(updated.steps.aggression).toBe(0.25); // halved from 0.5
    expect(updated.converged).toBe(false); // 0.25 still >= minStep(0.25)
  });

  it('is an idempotent no-op (only bumping `round`) once the checkpoint has already converged', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(500), converged: true };
    const updated = applyRoundResult(checkpoint, 3, KNOBS, []);
    expect(updated).toEqual({ ...checkpoint, round: 3 });
  });

  it('does NOT promote a higher-scoring candidate that flips an incumbent win into a loss — promotes a lower-scoring QUALIFYING candidate instead', () => {
    // Reproduces the exact class of bug GH run 29597840666 exposed: a config
    // that out-scores the incumbent while quietly flipping incumbent wins
    // into losses must never be adopted by the search's own hill-climb, even
    // though score-only promotion (the pre-fix behaviour) would pick it.
    const baseline = shard(
      [row(BASE_ID, 'sword', 1, 150, true), row(BASE_ID, 'bow', 2, 150, true)],
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // bestScore = 300

    const flippy: SweepConfig = { ...BASE, aggression: 1.5 };
    const flippyId = configId(flippy);
    // Higher score (1400) but flips the incumbent's 'bow'/seed-2 win into a loss.
    const flippyShard = shard(
      [row(flippyId, 'sword', 1, 700, true), row(flippyId, 'bow', 2, 700, false)],
      { [flippyId]: flippy },
    );

    const safe: SweepConfig = { ...BASE, aggression: 0.5 };
    const safeId = configId(safe);
    // Lower score (700) but wins BOTH cells the incumbent won — zero flips, 100% win rate.
    const safeShard = shard(
      [row(safeId, 'sword', 1, 350, true), row(safeId, 'bow', 2, 350, true)],
      { [safeId]: safe },
    );

    const updated = applyRoundResult(checkpoint, 1, KNOBS, [flippyShard, safeShard]);
    expect(updated.bestConfigId).toBe(safeId); // NOT flippyId, despite its higher score
    expect(updated.bestScore).toBe(700);
    expect(updated.converged).toBe(false); // it did improve, so steps are untouched
    expect(updated.steps.aggression).toBe(0.5);
  });

  it('rejects the ONLY out-scoring candidate purely for its flip, isolated from the win-rate floor (>=90% win rate + 1 flip must still disqualify)', () => {
    // Code-review finding: the two tests above use a 50%-win-rate flippy
    // candidate, which is ALSO disqualified by the win-rate floor alone —
    // removing just the `flipsVsIncumbent === 0` clause from
    // `selectQualifiedWinner` would not fail either test. This test isolates
    // the flip gate specifically by giving the candidate a 90% win rate
    // (mirroring GH run 29597840666's 97.3%) with exactly ONE flip, so it
    // would pass the win-rate floor on its own but must still be rejected.
    const baselineRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      // Incumbent wins seeds 1-9, loses seed 10.
      baselineRows.push(row(BASE_ID, 'sword', seed, 100, seed !== 10));
    }
    const checkpoint = initCheckpoint(
      LEGACY_LEGACY,
      KNOBS,
      shard(baselineRows, { [BASE_ID]: BASE }),
    ); // bestScore = 1000 (10 rows x score 100 -- win/loss doesn't zero the score)

    const flippy: SweepConfig = { ...BASE, aggression: 1.5 };
    const flippyId = configId(flippy);
    const flippyRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      // Wins everything EXCEPT seed 5 (a flip -- incumbent won seed 5) and
      // ALSO wins seed 10 (a recovery, not a flip). 9/10 = 90% win rate.
      flippyRows.push(row(flippyId, 'sword', seed, 200, seed !== 5));
    }
    const flippyShard = shard(flippyRows, { [flippyId]: flippy });

    const updated = applyRoundResult(checkpoint, 1, KNOBS, [flippyShard]);
    // Sanity-check the fixture: flippy both clears the 90% win-rate floor AND
    // out-scores the baseline (10*200=2000 > 1000) -- so a naive win-rate-only
    // or score-only gate would wrongly promote it.
    expect(updated.bestConfigId).toBe(BASE_ID); // NOT flippyId
    expect(updated.bestScore).toBe(1000);
    expect(updated.steps.aggression).toBe(0.25); // halved -- nothing qualified
    expect(updated.converged).toBe(false);
  });

  it('halves steps (does not promote anything) when the only out-scoring candidate is disqualified by a flip', () => {
    const baseline = shard(
      [row(BASE_ID, 'sword', 1, 150, true), row(BASE_ID, 'bow', 2, 150, true)],
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // bestScore = 300

    const flippy: SweepConfig = { ...BASE, aggression: 1.5 };
    const flippyId = configId(flippy);
    const flippyShard = shard(
      [row(flippyId, 'sword', 1, 700, true), row(flippyId, 'bow', 2, 700, false)],
      { [flippyId]: flippy },
    );

    const updated = applyRoundResult(checkpoint, 1, KNOBS, [flippyShard]);
    expect(updated.bestConfigId).toBe(BASE_ID); // unchanged — the only candidate is disqualified
    expect(updated.bestScore).toBe(300);
    expect(updated.steps.aggression).toBe(0.25); // halved, exactly as if nothing had improved
    expect(updated.converged).toBe(false);
  });

  it('degrades gracefully (halves steps, preserves prior progress) when a round produced ZERO candidate shards and no `plannedCount` is supplied (legacy caller)', () => {
    // Simulates every one of this combo's round-eval matrix legs failing —
    // the timeout/partial-progress case this whole redesign exists for. When
    // the caller doesn't supply `plannedCount` (e.g. an older/simpler caller,
    // or genuinely nothing was ever planned), the original always-halve
    // behaviour is preserved.
    const checkpoint = baseCheckpoint(500);
    const updated = applyRoundResult(checkpoint, 1, KNOBS, []);
    expect(updated.bestConfigId).toBe(checkpoint.bestConfigId);
    expect(updated.bestScore).toBe(checkpoint.bestScore);
    expect(updated.rows).toEqual(checkpoint.rows); // no data lost
    expect(updated.configs).toEqual(checkpoint.configs);
    expect(updated.steps.aggression).toBe(0.25); // still halves toward convergence
    expect(updated.converged).toBe(false);
  });

  it('does NOT halve/converge when `plannedCount` reveals some candidates never produced a shard (infra failure, not a search dead-end)', () => {
    // 2 candidates were planned this round; ZERO shards arrived (both matrix
    // legs failed/timed out). This must NOT be conflated with "the search
    // tried both neighbours and neither improved" — the steps must stay
    // exactly as they were so `planCandidates` regenerates the SAME
    // neighbour set next round instead of prematurely narrowing the search.
    const checkpoint = baseCheckpoint(500);
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [], { plannedCount: 2 });
    expect(updated.bestConfigId).toBe(checkpoint.bestConfigId);
    expect(updated.bestScore).toBe(checkpoint.bestScore);
    expect(updated.steps).toEqual(checkpoint.steps); // NOT halved
    expect(updated.converged).toBe(checkpoint.converged);
  });

  it('still halves when `plannedCount: 0` is a LEGITIMATE zero (planner ran and decided this combo needed nothing)', () => {
    // plannedCount=0 means the planner job itself succeeded and produced a
    // manifest that genuinely lists zero candidates for this combo — this is
    // real search information (the SAME signal a converged/at-minStep combo
    // would produce), not an infra failure, so it must still halve/converge
    // normally. This is the control case that proves `0` and `'unknown'`
    // (below) are deliberately handled differently.
    const checkpoint = baseCheckpoint(500);
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [], { plannedCount: 0 });
    expect(updated.bestConfigId).toBe(checkpoint.bestConfigId);
    expect(updated.steps.aggression).toBe(0.25); // halved — genuinely nothing was planned
    expect(updated.converged).toBe(false);
  });

  it("does NOT halve/converge when `plannedCount: 'unknown'` — the planner job never produced a manifest at all", () => {
    // Distinct from the `plannedCount: 0` case above: 'unknown' means
    // roundN-candidates itself crashed/never uploaded candidates.json, so we
    // cannot tell whether 0 or N candidates were planned for this combo.
    // Must ALWAYS be treated as an infra failure (never halve/converge),
    // even though candidateShards is empty here exactly as it would be for a
    // genuine dead-end — the sentinel, not the shard count, drives this.
    const checkpoint = baseCheckpoint(500);
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [], { plannedCount: 'unknown' });
    expect(updated.bestConfigId).toBe(checkpoint.bestConfigId);
    expect(updated.steps).toEqual(checkpoint.steps); // NOT halved
    expect(updated.converged).toBe(checkpoint.converged);
  });

  it('does NOT halve/converge on a PARTIAL round (some but not all planned candidates arrived) even when the arrived one does not improve', () => {
    const checkpoint = baseCheckpoint(500);
    const worse: SweepConfig = { ...BASE, aggression: 1.5 };
    const worseId = configId(worse);
    const candidateShard = shard([row(worseId, 'sword', 1, 10)], { [worseId]: worse });
    // 2 were planned, only 1 arrived (the other matrix leg failed).
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [candidateShard], { plannedCount: 2 });
    expect(updated.bestConfigId).toBe(BASE_ID); // unchanged — worse doesn't qualify to beat it anyway
    expect(updated.steps.aggression).toBe(0.5); // NOT halved — round was incomplete
    expect(updated.converged).toBe(false);
    // The one shard that DID arrive is still merged in — no data lost.
    expect(updated.rows).toHaveLength(2);
    expect(updated.configs).toHaveProperty(worseId);
  });

  it('still halves normally when `plannedCount` matches the candidates actually received and none improve (no false safety net)', () => {
    const checkpoint = baseCheckpoint(500);
    const worse: SweepConfig = { ...BASE, aggression: 1.5 };
    const worseId = configId(worse);
    const candidateShard = shard([row(worseId, 'sword', 1, 10)], { [worseId]: worse });
    // 1 was planned, 1 arrived — a genuinely complete round with no improvement.
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [candidateShard], { plannedCount: 1 });
    expect(updated.bestConfigId).toBe(BASE_ID);
    expect(updated.steps.aggression).toBe(0.25); // halved — this round genuinely completed
    expect(updated.converged).toBe(false);
  });

  it('marks converged once a knob’s step has halved below its minStep across repeated non-improving rounds', () => {
    let checkpoint = baseCheckpoint(500);
    // Round 1: no improvement -> step 0.5 -> 0.25 (still >= minStep 0.25).
    checkpoint = applyRoundResult(checkpoint, 1, KNOBS, []);
    expect(checkpoint.converged).toBe(false);
    // Round 2: no improvement -> step 0.25 -> 0.125 (< minStep 0.25) -> converged.
    checkpoint = applyRoundResult(checkpoint, 2, KNOBS, []);
    expect(checkpoint.steps.aggression).toBe(0.125);
    expect(checkpoint.converged).toBe(true);
  });

  it('throws on a conflicting config definition for the same id (determinism violation across shards)', () => {
    const checkpoint = baseCheckpoint();
    const candidate: SweepConfig = { ...BASE, aggression: 1.5 };
    const candidateId = configId(candidate);
    const shardA = shard([row(candidateId, 'sword', 1, 200)], { [candidateId]: candidate });
    // Same id, but a DIFFERENT config body -- a real determinism violation.
    const tampered: SweepConfig = { ...candidate, aggression: 1.75 };
    const shardB = shard([row(candidateId, 'bow', 1, 200)], { [candidateId]: tampered });
    expect(() => applyRoundResult(checkpoint, 1, KNOBS, [shardA, shardB])).toThrow(
      /conflicting config definition/,
    );
  });

  it('dedups an identical duplicate row seen across two shards (cross-shard determinism proof)', () => {
    const checkpoint = baseCheckpoint();
    const candidate: SweepConfig = { ...BASE, aggression: 1.5 };
    const candidateId = configId(candidate);
    const sharedRow = row(candidateId, 'sword', 1, 200);
    const shardA = shard([sharedRow], { [candidateId]: candidate });
    const shardB = shard([{ ...sharedRow }], { [candidateId]: candidate });
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [shardA, shardB]);
    // 1 baseline row + 1 deduped candidate row, NOT 1 + 2.
    expect(updated.rows).toHaveLength(2);
  });

  it('throws on conflicting run facts for the same (configId, weapon, seed) key across two shards', () => {
    // A conflicting duplicate is NOT a benign cross-shard re-send: the same
    // (configId, weapon, seed) key producing different scores/outcomes across
    // two shards is a determinism violation analogous to the config-definition
    // conflict check — must throw rather than silently keeping the first.
    const checkpoint = baseCheckpoint();
    const candidate: SweepConfig = { ...BASE, aggression: 1.5 };
    const candidateId = configId(candidate);
    const shardA = shard([row(candidateId, 'sword', 1, 200)], { [candidateId]: candidate });
    // Same key (candidateId, 'sword', seed 1) but different score — conflicting.
    const shardB = shard([row(candidateId, 'sword', 1, 999)], { [candidateId]: candidate });
    expect(() => applyRoundResult(checkpoint, 1, KNOBS, [shardA, shardB])).toThrow(
      /conflicting run result/,
    );
  });

  it('applies the full tie-break ordering (not just score) when selecting among qualifying candidates of equal total score', () => {
    // Two qualifying candidates have identical totalScore but different clear
    // times. The one with the FASTER clear time must win — score-only promotion
    // would arbitrarily keep whichever appeared first (since neither `>` the other).
    const baseline = shard(
      Array.from({ length: 10 }, (_, i) => row(BASE_ID, 'sword', i + 1, 100, true)),
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // bestScore = 1000

    const slower: SweepConfig = { ...BASE, aggression: 1.5 };
    const slowerId = configId(slower);
    const slowerRows = Array.from({ length: 10 }, (_, i) =>
      row(slowerId, 'sword', i + 1, 200, true),
    );
    // Override gameTimeMs to a SLOWER clear (250_000 ms vs the default 100_000 ms).
    slowerRows.forEach((r) => {
      (r as { gameTimeMs: number }).gameTimeMs = 250_000;
    });

    const faster: SweepConfig = { ...BASE, aggression: 0.5 };
    const fasterId = configId(faster);
    const fasterRows = Array.from({ length: 10 }, (_, i) =>
      row(fasterId, 'sword', i + 1, 200, true),
    );
    // Keep gameTimeMs at the default 100_000 ms (faster clear).

    // Both candidates have totalScore = 2000 (equal). faster has meanClearTimeMsWins < slower.
    const slowerShard = shard(slowerRows, { [slowerId]: slower });
    const fasterShard = shard(fasterRows, { [fasterId]: faster });

    const updated = applyRoundResult(checkpoint, 1, KNOBS, [slowerShard, fasterShard]);
    // The faster candidate must be selected via tie-break, not the slower one.
    expect(updated.bestConfigId).toBe(fasterId);
    expect(updated.bestScore).toBe(2000);
  });

  it('throws when a candidate shard is provenance-incompatible with the checkpoint (schemaVersion mismatch)', () => {
    const checkpoint = baseCheckpoint();
    const candidate: SweepConfig = { ...BASE, aggression: 1.5 };
    const candidateId = configId(candidate);
    const badShard: ShardArtifact = {
      meta: { ...META, schemaVersion: SHARD_SCHEMA_VERSION + 1 },
      configs: { [candidateId]: candidate },
      rows: [row(candidateId, 'sword', 1, 200)],
    };
    expect(() => applyRoundResult(checkpoint, 1, KNOBS, [badShard])).toThrow(
      /schemaVersion .* != checkpoint/,
    );
  });

  it('throws when a candidate shard is provenance-incompatible with the checkpoint (budgetMs mismatch)', () => {
    const checkpoint = baseCheckpoint();
    const candidate: SweepConfig = { ...BASE, aggression: 1.5 };
    const candidateId = configId(candidate);
    const badShard: ShardArtifact = {
      meta: { ...META, budgetMs: META.budgetMs + 1000 },
      configs: { [candidateId]: candidate },
      rows: [row(candidateId, 'sword', 1, 200)],
    };
    expect(() => applyRoundResult(checkpoint, 1, KNOBS, [badShard])).toThrow(
      /budgetMs .* != checkpoint/,
    );
  });
});

describe('toSearchArtifact', () => {
  it('projects a RoundCheckpoint down to the legacy SearchArtifact shape, losslessly for `validate`', () => {
    const checkpoint = baseCheckpoint(150);
    const artifact = toSearchArtifact(checkpoint);
    expect(artifact).toEqual({
      meta: checkpoint.meta,
      combo: checkpoint.combo,
      bestConfigId: checkpoint.bestConfigId,
      configs: checkpoint.configs,
      rows: checkpoint.rows,
    });
    // Round-planning-only fields must NOT leak into the legacy shape.
    expect(artifact).not.toHaveProperty('round');
    expect(artifact).not.toHaveProperty('bestScore');
    expect(artifact).not.toHaveProperty('steps');
    expect(artifact).not.toHaveProperty('converged');
    expect(artifact).not.toHaveProperty('incumbentConfigId');
  });
});

describe('halveSteps', () => {
  it('halves every knob’s step and reports true while any knob is still >= its minStep', () => {
    const steps: Partial<Record<TunableKnob, number>> = { aggression: 0.5 };
    const anyAboveMin = halveSteps(steps, KNOBS);
    expect(steps.aggression).toBe(0.25);
    expect(anyAboveMin).toBe(true); // 0.25 >= minStep(0.25)
  });

  it('reports false once every knob has halved below its minStep', () => {
    const steps: Partial<Record<TunableKnob, number>> = { aggression: 0.2 };
    const anyAboveMin = halveSteps(steps, KNOBS);
    expect(steps.aggression).toBe(0.1);
    expect(anyAboveMin).toBe(false); // 0.1 < minStep(0.25)
  });

  it('seeds an unset knob from its default range step before halving', () => {
    const steps: Partial<Record<TunableKnob, number>> = {};
    halveSteps(steps, KNOBS);
    expect(steps.aggression).toBe(0.25); // default step 0.5, halved once
  });
});
