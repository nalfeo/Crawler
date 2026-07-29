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
 *     graduation (human-approved net-win rule: >=90% official wins AND
 *     STRICTLY MORE total wins than the incumbent — win→loss flips are
 *     allowed as long as the candidate's absolute win count still increases)
 *     — a higher-scoring candidate whose win count ties or decreases vs the
 *     incumbent must never be promoted (this is the fix for the real bug the
 *     2026-07 untuned graduation run, GH run 29597840666, exposed, and the
 *     policy the human later refined: a 292/300-win candidate with 5 flips
 *     vs a 286/300-win incumbent nets 6 MORE total wins and should qualify —
 *     the old zero-flips gate wrongly rejected it);
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
  assertResumeCompatible,
  buildResumeLineageArtifact,
  extractLegacyBaselineShard,
  halveSteps,
  inferRunInputsFromCheckpoint,
  initCheckpoint,
  normalizeResumedCheckpoint,
  planCandidates,
  planRoundMatrix,
  resolveInitRunInputs,
  toSearchArtifact,
  type CheckpointWithKnobs,
  type ResumeExpectedProvenance,
  type RoundCheckpoint,
} from '../../../scripts/agent/perf/round-plan.js';
import {
  baseConfigForCombo,
  configId,
  LEGACY_COMBO_ID,
  SECONDARY_KNOBS,
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
  pathing: AIPathingMode.RISK_REWARD_FUSED,
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
  combo = 'riskRewardFused+legacy',
): RunRow {
  return {
    combo,
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

/** A complete, duplicate-free, rectangular (seed × weapon) baseline shard for
 *  `legacy+legacy` — the shape `inferRunInputsFromCheckpoint` requires to
 *  safely infer a legacy checkpoint's implicit TRAIN seed panel + weapon
 *  list. Mirrors cancelled run 29786216369's actual baseline shape (a full
 *  train-seed × weapon sweep of the canonical LEGACY base config). */
function legacyPanelShard(seeds: number[], weapons: string[]): ShardArtifact {
  const rows: RunRow[] = [];
  for (const s of seeds) {
    for (const w of weapons) {
      rows.push(row(BASE_ID, w, s, 100));
    }
  }
  return shard(rows, { [BASE_ID]: BASE });
}

/** A legacy (pre-resume-support) `legacy+legacy` checkpoint — no `runInputs` —
 *  whose round-0 baseline rows form the given seed × weapon panel. */
function legacyCheckpointWithPanel(seeds: number[], weapons: string[]): RoundCheckpoint {
  return initCheckpoint(LEGACY_LEGACY, KNOBS, legacyPanelShard(seeds, weapons));
}

/** A complete, duplicate-free, rectangular (seed × weapon) shard for an
 *  arbitrary (config, combo) pair — generalizes `legacyPanelShard` beyond the
 *  canonical LEGACY base config, for building a non-LEGACY checkpoint's OWN
 *  base panel (as distinct from its separate LEGACY incumbent panel). */

describe('initCheckpoint', () => {
  it('builds a round-0 checkpoint seeded from the baseline shard', () => {
    const checkpoint = baseCheckpoint(150);
    expect(checkpoint.combo).toBe('riskRewardFused+legacy');
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

  it('stamps the optional runInputs (TRAIN seeds + weapons + secondary) onto the checkpoint verbatim when supplied, and omits the field entirely when not', () => {
    const withRunInputs = initCheckpoint(LEGACY_LEGACY, KNOBS, baselineShard(150), undefined, {
      trainSeeds: '1-24',
      weapons: 'sword,bow,baseball-bat',
      secondary: true,
    });
    expect(withRunInputs.runInputs).toEqual({
      trainSeeds: '1-24',
      weapons: 'sword,bow,baseball-bat',
      secondary: true,
    });

    // Legacy caller (no runInputs arg) must NOT get a `runInputs: undefined`
    // key — assertResumeCompatible's `!checkpoint.runInputs` check must see a
    // genuinely absent field, matching real pre-resume-support checkpoints.
    const withoutRunInputs = baseCheckpoint(150);
    expect('runInputs' in withoutRunInputs).toBe(false);
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

  it('with no `round` argument, behaves exactly as before (round-agnostic — legacy call sites unaffected)', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(), round: 2 };
    expect(planCandidates(checkpoint, KNOBS)).toHaveLength(2);
  });

  it('a cross-run RESUMED checkpoint already past this round emits ZERO candidates for it — the fix for the real "extra optimization step" bug (Copilot review finding #4)', () => {
    // Without the `round` gate, planCandidates only looks at `converged`/
    // `configs`, so a checkpoint imported at round 2 would still emit fresh
    // round-1 candidates when round1-candidates re-derives its neighbour set
    // — silently performing an UNREQUESTED extra coordinate-ascent step using
    // the checkpoint's CURRENT (already-reduced) step size.
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(), round: 2 };
    expect(planCandidates(checkpoint, KNOBS, 1)).toEqual([]);
  });

  it('a checkpoint exactly AT the requested round also emits zero candidates (>= is inclusive — this round already ran)', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(), round: 1 };
    expect(planCandidates(checkpoint, KNOBS, 1)).toEqual([]);
  });

  it('a checkpoint BEHIND the requested round still plans normally (ordinary fresh-run progression is unaffected)', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(), round: 0 };
    expect(planCandidates(checkpoint, KNOBS, 1)).toHaveLength(2);
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

  it('forwards `round` to planCandidates so a resumed-ahead combo contributes zero candidates while a fresh sibling combo still plans normally', () => {
    const checkpoints: CheckpointWithKnobs[] = [
      // Resumed at round 2 -- must plan nothing for round 1.
      { checkpoint: { ...baseCheckpoint(), combo: 'legacy+legacy', round: 2 }, knobs: KNOBS },
      // Fresh at round 0 -- must plan its 2 round-1 neighbours normally.
      { checkpoint: { ...baseCheckpoint(), combo: 'navmeshFused+legacy', round: 0 }, knobs: KNOBS },
    ];
    const matrix = planRoundMatrix(checkpoints, 200, 1);
    expect(matrix).toHaveLength(2);
    expect(new Set(matrix.map((c) => c.combo))).toEqual(new Set(['navmeshFused+legacy']));
  });
});

describe('applyRoundResult', () => {
  it('adopts a genuinely improving candidate as the new best, leaving steps untouched', () => {
    // Code-review finding: winsVsIncumbentDelta is only computed when the
    // candidate's (weapon, seed) cell set is IDENTICAL to the incumbent's, so
    // this uses a custom 2-cell incumbent panel (not the shared 1-cell
    // baseCheckpoint helper) that the candidate matches exactly.
    const baseline = shard(
      [row(BASE_ID, 'sword', 1, 100, true), row(BASE_ID, 'bow', 2, 100, false)],
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // bestScore = 200, 1 win
    const better: SweepConfig = { ...BASE, aggression: 1.5 };
    const betterId = configId(better);
    // Wins BOTH cells on the same panel -> strictly more total wins (2) than
    // the incumbent's 1.
    const candidateShard = shard([row(betterId, 'sword', 1, 500), row(betterId, 'bow', 2, 100)], {
      [betterId]: better,
    });
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [candidateShard]);
    expect(updated.bestConfigId).toBe(betterId);
    expect(updated.bestScore).toBe(600);
    expect(updated.round).toBe(1);
    expect(updated.steps.aggression).toBe(0.5); // unchanged on improvement
    expect(updated.converged).toBe(false);
    // Prior + new rows/configs both retained.
    expect(updated.rows).toHaveLength(4); // 2 baseline rows + 2 candidate rows
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

  it('does NOT promote a higher-scoring candidate that flips an incumbent win into a loss (net win count DECREASES) — promotes a lower-scoring candidate with strictly more total wins instead', () => {
    // Reproduces the exact class of bug GH run 29597840666 exposed: a config
    // that out-scores the incumbent while quietly flipping incumbent wins
    // into losses must never be adopted by the search's own hill-climb, even
    // though score-only promotion (the pre-fix behaviour) would pick it.
    // Code-review finding: winsVsIncumbentDelta is only computed when a
    // candidate's (weapon, seed) cell set exactly matches the incumbent's, so
    // all three configs here share the same 3-cell panel (sword/1, bow/2,
    // dagger/3) — nobody wins a cell the incumbent never ran.
    const baseline = shard(
      [
        row(BASE_ID, 'sword', 1, 150, true),
        row(BASE_ID, 'bow', 2, 150, true),
        row(BASE_ID, 'dagger', 3, 150, false),
      ],
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // bestScore = 450, 2 wins

    const flippy: SweepConfig = { ...BASE, aggression: 1.5 };
    const flippyId = configId(flippy);
    // Higher score (2100) but flips the incumbent's 'bow'/seed-2 win into a
    // loss => 1 total win, strictly FEWER than the incumbent's 2 — a decrease.
    const flippyShard = shard(
      [
        row(flippyId, 'sword', 1, 700, true),
        row(flippyId, 'bow', 2, 700, false),
        row(flippyId, 'dagger', 3, 700, false),
      ],
      { [flippyId]: flippy },
    );

    const safe: SweepConfig = { ...BASE, aggression: 0.5 };
    const safeId = configId(safe);
    // Lower score (1050) but wins all 3 shared cells => 3 total wins, strictly
    // MORE than the incumbent's 2.
    const safeShard = shard(
      [
        row(safeId, 'sword', 1, 350, true),
        row(safeId, 'bow', 2, 350, true),
        row(safeId, 'dagger', 3, 350, true),
      ],
      { [safeId]: safe },
    );

    const updated = applyRoundResult(checkpoint, 1, KNOBS, [flippyShard, safeShard]);
    expect(updated.bestConfigId).toBe(safeId); // NOT flippyId, despite its higher score
    expect(updated.bestScore).toBe(1050);
    expect(updated.converged).toBe(false); // it did improve, so steps are untouched
    expect(updated.steps.aggression).toBe(0.5);
  });

  it('rejects the ONLY out-scoring candidate whose total win count only TIES the incumbent (>=90% win rate + a tie must still disqualify)', () => {
    // Code-review finding: the two tests around this one use a 50%-win-rate
    // flippy candidate, which is ALSO disqualified by the win-rate floor
    // alone — that wouldn't isolate the net-win clause. This test isolates it
    // specifically by giving the candidate a 90% win rate (mirroring GH run
    // 29597840666's 97.3%) whose flip is exactly offset by a recovery, so its
    // total win COUNT only ties the incumbent's — not a strict increase — and
    // must still be rejected even though it clears the win-rate floor easily.
    const baselineRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      // Incumbent wins seeds 1-9, loses seed 10. Total wins = 9.
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
      // ALSO wins seed 10 (a recovery, not a flip). Net wins = 9 - 1 + 1 = 9,
      // TIED with the incumbent's 9. 90% win rate.
      flippyRows.push(row(flippyId, 'sword', seed, 200, seed !== 5));
    }
    const flippyShard = shard(flippyRows, { [flippyId]: flippy });

    const updated = applyRoundResult(checkpoint, 1, KNOBS, [flippyShard]);
    // Sanity-check the fixture: flippy both clears the 90% win-rate floor AND
    // out-scores the baseline (10*200=2000 > 1000) -- so a naive win-rate-only
    // or score-only gate would wrongly promote it. Its win count only ties
    // the incumbent's (9 == 9), which is not a strict increase.
    expect(updated.bestConfigId).toBe(BASE_ID); // NOT flippyId
    expect(updated.bestScore).toBe(1000);
    expect(updated.steps.aggression).toBe(0.25); // halved -- nothing qualified
    expect(updated.converged).toBe(false);
  });

  it('halves steps (does not promote anything) when the only out-scoring candidate is disqualified for a net-win decrease', () => {
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

  it('does NOT promote an improving candidate when the round is partial (a missing shard might have been better, and promoting changes the search trajectory)', () => {
    // This is the key invariant: even when a qualifying candidate arrives and
    // would normally be promoted, if plannedCount reveals some shards are missing,
    // we must NOT promote. Otherwise the next round's planCandidates derives
    // neighbours of the NEW best instead of the OLD best, permanently skipping
    // the missing candidate. The arrived data is still merged in (deduped next
    // round) and the search retries from the same position.
    // Code-review finding: the candidate must share the incumbent's exact
    // (weapon, seed) panel for winsVsIncumbentDelta to be non-null, so the
    // baseline also runs dagger/3 (as a loss) rather than the candidate
    // winning a cell the incumbent never ran.
    const baseline = shard(
      [
        row(BASE_ID, 'sword', 1, 100, true),
        row(BASE_ID, 'bow', 2, 100, true),
        row(BASE_ID, 'dagger', 3, 100, false),
      ],
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // bestScore = 300, 2 wins

    const better: SweepConfig = { ...BASE, aggression: 1.5 };
    const betterId = configId(better);
    // This candidate genuinely qualifies (100% win rate, 3 total wins —
    // strictly more than the baseline's 2) and outscores the baseline.
    const betterShard = shard(
      [
        row(betterId, 'sword', 1, 500, true),
        row(betterId, 'bow', 2, 500, true),
        row(betterId, 'dagger', 3, 500, true),
      ],
      { [betterId]: better },
    );

    // 2 were planned, only 1 arrived — incomplete round.
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [betterShard], { plannedCount: 2 });
    // Despite `better` qualifying and outscoring the baseline, must NOT be promoted.
    expect(updated.bestConfigId).toBe(BASE_ID); // unchanged
    expect(updated.bestScore).toBe(300); // unchanged
    expect(updated.steps.aggression).toBe(0.5); // NOT halved — round was incomplete
    expect(updated.converged).toBe(false);
    // Data is still merged in for deduplication next round.
    expect(updated.configs).toHaveProperty(betterId);
    expect(updated.rows).toHaveLength(6); // 3 baseline + 3 candidate
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

  it('does NOT advance `checkpoint.round` when the round is infra-incomplete (missing shards) — the round LABEL must stay at the last genuinely-complete tier', () => {
    // Code-review finding (13th thread): the checkpoint's SEARCH STATE
    // (bestConfigId/steps/converged) was already correctly frozen for an
    // infra-incomplete round by the tests above, but the returned `round`
    // field must ALSO stay at the prior value — otherwise a cross-run resume
    // whose `rounds` input exactly matches this checkpoint's (falsely
    // advanced) round would validate against permanently-incomplete search
    // data. `checkpoint.round` starts at 0 (baseCheckpoint uses
    // initCheckpoint); calling round 1 with an infra-incomplete result must
    // leave `round` at 0, not bump it to 1.
    const checkpoint = baseCheckpoint(500);
    expect(checkpoint.round).toBe(0);
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [], { plannedCount: 2 });
    expect(updated.round).toBe(0); // NOT bumped to 1 — round 1 never actually completed
  });

  it('DOES advance `checkpoint.round` to the requested round on a genuinely complete round (control case proving the infra-incomplete guard is targeted, not a general round-advance regression)', () => {
    const checkpoint = baseCheckpoint(500);
    const worse: SweepConfig = { ...BASE, aggression: 1.5 };
    const worseId = configId(worse);
    const candidateShard = shard([row(worseId, 'sword', 1, 10)], { [worseId]: worse });
    // 1 planned, 1 arrived — genuinely complete.
    const updated = applyRoundResult(checkpoint, 1, KNOBS, [candidateShard], { plannedCount: 1 });
    expect(updated.round).toBe(1); // advances normally — no infra failure occurred
  });

  it('an infra-incomplete round-N checkpoint correctly fails assertResumeCompatible for the rN tier it was uploaded under, self-healing a resumed run back to the last genuinely-complete tier', () => {
    // End-to-end proof that the 13th-thread fix and the existing 10th-thread
    // combo/round binding compose correctly: round 2 fails to fully complete
    // (an infra failure drops a shard), so the checkpoint that would be
    // uploaded as `search-checkpoint-r2-<combo>.json` still internally
    // reports round 1 (per the test above). A NEW dispatch requesting
    // `rounds=2` must reject THIS artifact for the r2 slot — exactly the
    // existing "mislabeled artifact" guard — so `resume-import`'s tier scan
    // falls back to the genuinely-complete r1 (or earlier) artifact instead
    // of silently validating incomplete round-2 search state.
    let checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baselineShard(150), undefined, {
      trainSeeds: '1-24',
      weapons: 'sword,bow,baseball-bat',
      secondary: false,
    });
    // Round 1 completes genuinely.
    checkpoint = applyRoundResult(checkpoint, 1, KNOBS, []);
    expect(checkpoint.round).toBe(1);
    // Round 2 is infra-incomplete (a shard never arrived) — round must NOT advance.
    checkpoint = applyRoundResult(checkpoint, 2, KNOBS, [], { plannedCount: 2 });
    expect(checkpoint.round).toBe(1);

    const expectedR2: ResumeExpectedProvenance = {
      meta: { ...META },
      trainSeeds: '1-24',
      weapons: 'sword,bow,baseball-bat',
      secondary: false,
      combo: LEGACY_COMBO_ID,
      round: 2, // the tier this checkpoint was (mis)uploaded as search-checkpoint-r2-*
    };
    expect(() => assertResumeCompatible(checkpoint, expectedR2)).toThrow(
      /checkpoint round 1 != expected round 2/,
    );

    // But it DOES validate cleanly against the tier it actually, genuinely completed.
    const expectedR1: ResumeExpectedProvenance = { ...expectedR2, round: 1 };
    expect(() => assertResumeCompatible(checkpoint, expectedR1)).not.toThrow();
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
      // Incumbent wins 9/10 (loses the last seed) so both 10/10 candidates
      // below have strictly MORE total wins than it, not just a tie.
      Array.from({ length: 10 }, (_, i) => row(BASE_ID, 'sword', i + 1, 100, i !== 9)),
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

    // Both candidates have totalScore = 2000 (equal) and 10 wins (strictly
    // more than the incumbent's 9). faster has meanClearTimeMsWins < slower.
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

  it('is an idempotent no-op for a round a cross-run resume already completed (checkpoint.round >= round, no shards) — never relabels round backward', () => {
    // The fix for Copilot review finding #4: `round1-select` for a combo
    // resumed at round 2 must not overwrite `checkpoint.round` back to 1 —
    // `planCandidates(..., 1)` correspondingly plans (and thus evaluates)
    // nothing for round 1 on this checkpoint, so candidateShards is empty.
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(500), round: 2 };
    const updated = applyRoundResult(checkpoint, 1, KNOBS, []);
    expect(updated).toEqual(checkpoint); // fully unchanged, including round: 2
  });

  it('never relabels round backward even in the defensive case where shards ARE present for an already-past round', () => {
    // Belt-and-suspenders: even if a caller passes candidateShards despite
    // checkpoint.round already exceeding the requested round, the merged
    // checkpoint's `round` must never regress below its own prior value.
    // Uses a 2-cell panel (matching the "adopts a genuinely improving
    // candidate" fixture above) so the candidate genuinely clears the
    // net-win promotion gate — a 1-cell tie would never qualify.
    const baseline = shard(
      [row(BASE_ID, 'sword', 1, 100, true), row(BASE_ID, 'bow', 2, 100, false)],
      { [BASE_ID]: BASE },
    );
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baseline); // 1 win
    const advanced: RoundCheckpoint = { ...checkpoint, round: 2 };
    const better: SweepConfig = { ...BASE, aggression: 1.5 };
    const betterId = configId(better);
    // Wins both cells -> 2 total wins, strictly more than the incumbent's 1.
    const candidateShard = shard([row(betterId, 'sword', 1, 500), row(betterId, 'bow', 2, 100)], {
      [betterId]: better,
    });
    const updated = applyRoundResult(advanced, 1, KNOBS, [candidateShard]);
    expect(updated.round).toBe(2); // Math.max(1, 2), never regresses to 1
    expect(updated.bestConfigId).toBe(betterId); // merge/promotion logic still runs
  });

  it('still advances round forward normally for an ordinary fresh-run progression (round < checkpoint.round is the only special case)', () => {
    const checkpoint = baseCheckpoint(500);
    const updated = applyRoundResult(checkpoint, 1, KNOBS, []);
    expect(updated.round).toBe(1); // Math.max(1, 0) === 1, ordinary forward progress
  });

  it('preserves round on the already-converged idempotent-no-op path too (Math.max, not unconditional overwrite)', () => {
    const checkpoint: RoundCheckpoint = { ...baseCheckpoint(500), converged: true, round: 3 };
    const updated = applyRoundResult(checkpoint, 1, KNOBS, []);
    expect(updated.round).toBe(3); // Math.max(1, 3), never regresses to 1
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

describe('assertResumeCompatible (cross-run resume provenance gate, resume_run_id)', () => {
  // A resumed checkpoint must carry `runInputs` (real ones stamp this via
  // initCheckpoint's optional 5th arg — see the `initCheckpoint` describe
  // block above) and match the CURRENT run's expected provenance exactly.
  const resumedCheckpoint = (): RoundCheckpoint =>
    initCheckpoint(LEGACY_LEGACY, KNOBS, baselineShard(150), undefined, {
      trainSeeds: '1-24',
      weapons: 'sword,bow,baseball-bat',
      secondary: false,
    });

  const expected = (): ResumeExpectedProvenance => ({
    meta: { ...META },
    trainSeeds: '1-24',
    weapons: 'sword,bow,baseball-bat',
    secondary: false,
    combo: LEGACY_COMBO_ID,
    round: 0,
  });

  it('passes silently when every provenance field matches exactly', () => {
    expect(() => assertResumeCompatible(resumedCheckpoint(), expected())).not.toThrow();
  });

  it('throws when checkpoint.combo does not match expected.combo — a mislabeled artifact (wrong combo) must never be silently trusted from its filename alone', () => {
    const exp = expected();
    exp.combo = 'some-other-combo+mode'; // must differ from the checkpoint's combo
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(
      /checkpoint combo .* != expected combo/,
    );
  });

  it('throws when checkpoint.round does not match expected.round — a mislabeled artifact (wrong tier, e.g. an r2 checkpoint imported as r1) must never silently resume more or less optimization than requested', () => {
    const exp = expected();
    exp.round = 2; // resumedCheckpoint() is always round 0 (initCheckpoint)
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(
      /checkpoint round 0 != expected round 2/,
    );
  });

  it('checks combo/round BEFORE any other provenance field, so a mislabeled artifact fails fast with an unambiguous combo/round error rather than a confusing downstream one', () => {
    const exp = expected();
    exp.combo = 'some-other-combo+mode'; // mismatched combo
    exp.meta = { ...exp.meta, floorId: 'floor2' }; // would ALSO fail on floorId
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/checkpoint combo/);
  });

  it('reuses the existing strict shard-provenance checks: throws on schemaVersion mismatch', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, schemaVersion: SHARD_SCHEMA_VERSION + 1 };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/schemaVersion/);
  });

  it('reuses the existing strict shard-provenance checks: throws on floorId mismatch', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, floorId: 'floor2' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/floorId/);
  });

  it('reuses the existing strict shard-provenance checks: throws on budgetMs mismatch', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, budgetMs: exp.meta.budgetMs + 1 };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/budgetMs/);
  });

  it('reuses the existing strict shard-provenance checks: throws on maxFrames mismatch', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, maxFrames: exp.meta.maxFrames + 1 };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/maxFrames/);
  });

  it('throws on stage mismatch (a cross-run-only check, never varies intra-run)', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, stage: 'validate' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/stage/);
  });

  it('throws on runnerOs mismatch', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, runnerOs: 'macos' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/runner-OS/);
  });

  it('throws on nodeVersion mismatch', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, nodeVersion: 'v20.0.0' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/node-version/);
  });

  it('does NOT throw on packageLockHash mismatch — an incidental/transitive dependency bump (e.g. run 29786216369-vs-later-main lockfile drift) always differs once ANY dependency has since changed, so it is deliberately excluded from the gate (see docstring)', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, packageLockHash: 'ffffffffffffffffffffffff' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).not.toThrow();
  });

  it('does NOT throw on workflowSha mismatch — GITHUB_SHA always differs once the resuming workflow itself has changed, so it is deliberately excluded from the gate (see docstring)', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, workflowSha: 'ffffffffffffffffffffffffffffffff' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).not.toThrow();
  });

  it('still fails closed on a genuine incompatibility even when workflowSha ALSO differs (workflowSha exclusion does not widen the gate)', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, workflowSha: 'ffffffffffffffffffffffffffffffff', floorId: 'floor2' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/floorId/);
  });

  it('still fails closed on a genuine incompatibility even when packageLockHash ALSO differs (packageLockHash exclusion does not widen the gate)', () => {
    const exp = expected();
    exp.meta = { ...exp.meta, packageLockHash: 'ffffffffffffffffffffffff', floorId: 'floor2' };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/floorId/);
  });

  it('still fails closed on a genuine incompatibility even when BOTH workflowSha and packageLockHash differ (neither exclusion, together, widens the gate)', () => {
    const exp = expected();
    exp.meta = {
      ...exp.meta,
      workflowSha: 'ffffffffffffffffffffffffffffffff',
      packageLockHash: 'ffffffffffffffffffffffff',
      schemaVersion: SHARD_SCHEMA_VERSION + 1,
    };
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/schemaVersion/);
  });

  it('throws on trainSeeds mismatch (a different TRAIN panel makes scores incomparable)', () => {
    const exp = expected();
    exp.trainSeeds = '1-80';
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/trainSeeds/);
  });

  it('throws on weapons mismatch', () => {
    const exp = expected();
    exp.weapons = 'sword';
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/weapons/);
  });

  it('throws on secondary mismatch: checkpoint searched WITHOUT secondary knobs, dispatch expects them (knobsFor selects a different TunableKnob[] set)', () => {
    const exp = expected();
    exp.secondary = true; // checkpoint stamped secondary:false above
    expect(() => assertResumeCompatible(resumedCheckpoint(), exp)).toThrow(/secondary/);
  });

  it('throws on secondary mismatch: checkpoint searched WITH secondary knobs, dispatch expects the base set', () => {
    const checkpointWithSecondary = initCheckpoint(
      LEGACY_LEGACY,
      KNOBS,
      baselineShard(150),
      undefined,
      {
        trainSeeds: '1-24',
        weapons: 'sword,bow,baseball-bat',
        secondary: true,
      },
    );
    const exp = expected(); // secondary: false
    expect(() => assertResumeCompatible(checkpointWithSecondary, exp)).toThrow(/secondary/);
  });

  it('fails closed when a legacy checkpoint (no recorded runInputs) has only a 1-seed/1-weapon baseline panel that cannot match a multi-seed/multi-weapon expected TRAIN panel — inference is attempted (not an unconditional throw) but still fails closed on the resulting mismatch', () => {
    const legacyCheckpoint = baseCheckpoint(150); // no runInputs arg passed; baseline is 1 row (seed 1, sword)
    expect('runInputs' in legacyCheckpoint).toBe(false);
    expect(() => assertResumeCompatible(legacyCheckpoint, expected())).toThrow(
      /no recorded runInputs — inferred trainSeeds/,
    );
  });

  describe("legacy checkpoints with no recorded runInputs: safe inference from the checkpoint's own baseline panel (run 29786216369 recovery)", () => {
    // Mirrors cancelled run 29786216369's actual shape: a legacy (pre-runInputs)
    // checkpoint whose round-0 baseline is a complete train-seed x weapon sweep.
    const canonicalPanelCheckpoint = () => legacyCheckpointWithPanel([1, 2, 3], ['sword', 'bow']);
    const canonicalExpected = (): ResumeExpectedProvenance => ({
      meta: { ...META },
      trainSeeds: '1-3',
      weapons: 'sword,bow',
      secondary: false,
      combo: LEGACY_COMBO_ID,
      round: 0,
    });

    it('accepts a legacy checkpoint whose complete, duplicate-free, rectangular baseline panel exactly matches the requested trainSeeds/weapons/secondary (canonical run-29786216369 shape)', () => {
      expect(() =>
        assertResumeCompatible(canonicalPanelCheckpoint(), canonicalExpected()),
      ).not.toThrow();
    });

    it('rejects when the requested trainSeeds panel is a superset of the inferred panel (seed mismatch)', () => {
      const exp = canonicalExpected();
      exp.trainSeeds = '1-4'; // checkpoint panel only covers seeds 1-3
      expect(() => assertResumeCompatible(canonicalPanelCheckpoint(), exp)).toThrow(
        /no recorded runInputs — inferred trainSeeds/,
      );
    });

    it('rejects when the requested weapons list does not match the inferred weapons (weapon mismatch)', () => {
      const exp = canonicalExpected();
      exp.weapons = 'sword'; // checkpoint panel covers sword AND bow
      expect(() => assertResumeCompatible(canonicalPanelCheckpoint(), exp)).toThrow(
        /no recorded runInputs — inferred weapons/,
      );
    });

    it('rejects when the requested secondary flag does not match the inferred secondary flag (steps has no SECONDARY_KNOBS key => secondary=false)', () => {
      const exp = canonicalExpected();
      exp.secondary = true; // fixture's KNOBS=['aggression'] is a PRIMARY knob only
      expect(() => assertResumeCompatible(canonicalPanelCheckpoint(), exp)).toThrow(
        /no recorded runInputs — inferred secondary knobs flag/,
      );
    });

    it('rejects an incomplete/ragged panel (missing one (seed, weapon) combination) rather than guessing', () => {
      const rows: RunRow[] = [
        row(BASE_ID, 'sword', 1, 100),
        row(BASE_ID, 'bow', 1, 100),
        row(BASE_ID, 'sword', 2, 100),
        // missing (seed=2, weapon=bow): 3 rows for a would-be 2x2 panel
      ];
      const incompleteCheckpoint = initCheckpoint(
        LEGACY_LEGACY,
        KNOBS,
        shard(rows, { [BASE_ID]: BASE }),
      );
      const exp = canonicalExpected();
      exp.trainSeeds = '1-2';
      exp.weapons = 'sword,bow';
      expect(() => assertResumeCompatible(incompleteCheckpoint, exp)).toThrow(
        /do not form a complete rectangular panel/,
      );
    });

    it('rejects a duplicate (seed, weapon) row rather than guessing', () => {
      const rows: RunRow[] = [
        row(BASE_ID, 'sword', 1, 100),
        row(BASE_ID, 'sword', 1, 105), // duplicate (seed=1, weapon=sword)
      ];
      const duplicateCheckpoint = initCheckpoint(
        LEGACY_LEGACY,
        KNOBS,
        shard(rows, { [BASE_ID]: BASE }),
      );
      const exp = canonicalExpected();
      exp.trainSeeds = '1';
      exp.weapons = 'sword';
      expect(() => assertResumeCompatible(duplicateCheckpoint, exp)).toThrow(
        /duplicate own base config .* row/,
      );
    });

    it('does not weaken modern (runInputs present) behaviour: exact string comparison still applies even when the checkpoint would ALSO satisfy the panel-inference semantics', () => {
      // A checkpoint stamped with real runInputs from a different, but
      // semantically-equivalent-looking, weapon ordering must still fail on
      // simple string inequality — the modern path never falls through to
      // the lenient semantic-inference comparison.
      const modernCheckpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baselineShard(150), undefined, {
        trainSeeds: '1-24',
        weapons: 'bow,sword,baseball-bat', // different order, same set
        secondary: false,
      });
      const exp: ResumeExpectedProvenance = {
        meta: { ...META },
        trainSeeds: '1-24',
        weapons: 'sword,bow,baseball-bat',
        secondary: false,
        combo: LEGACY_COMBO_ID,
        round: 0,
      };
      expect(() => assertResumeCompatible(modernCheckpoint, exp)).toThrow(/weapons/);
    });

    it('rejects a requested trainSeeds string containing a duplicate seed, even if the DEDUPED set would otherwise match the inferred panel exactly', () => {
      // parseSeeds (the ACTUAL evaluator's --train-seeds/--seeds parser)
      // preserves duplicates verbatim -- a fresh leg requesting "1,1,2,3"
      // genuinely executes seed 1 TWICE and persists two rows for it, so
      // silently deduping the request before comparing would accept a
      // request whose fresh execution would NOT match the imported
      // duplicate-free panel's row set (found in review).
      const exp = canonicalExpected();
      exp.trainSeeds = '1,1,2,3'; // dedupes to [1,2,3], same as the inferred panel
      expect(() => assertResumeCompatible(canonicalPanelCheckpoint(), exp)).toThrow(
        /requested trainSeeds '1,1,2,3' contains duplicate seed/,
      );
    });

    it('rejects a requested weapons string containing an empty entry (stray/doubled comma)', () => {
      const exp = canonicalExpected();
      exp.weapons = 'sword,bow,'; // trailing comma -> empty 3rd entry
      expect(() => assertResumeCompatible(canonicalPanelCheckpoint(), exp)).toThrow(
        /requested weapons 'sword,bow,' contains an empty entry/,
      );
    });

    it('rejects a requested weapons string containing a duplicate weapon, even if the DEDUPED set would otherwise match the inferred panel exactly', () => {
      const exp = canonicalExpected();
      exp.weapons = 'sword,bow,sword'; // dedupes to {sword,bow}, same as inferred
      expect(() => assertResumeCompatible(canonicalPanelCheckpoint(), exp)).toThrow(
        /requested weapons 'sword,bow,sword' contains duplicate weapon/,
      );
    });
  });
});

describe('inferRunInputsFromCheckpoint (legacy checkpoint panel inference, unit-level)', () => {
  it('infers sorted/deduped trainSeeds + weapons + secondary=false from a complete rectangular panel', () => {
    const checkpoint = legacyCheckpointWithPanel([3, 1, 2], ['bow', 'sword']);
    expect(inferRunInputsFromCheckpoint(checkpoint)).toEqual({
      trainSeeds: [1, 2, 3],
      weapons: ['bow', 'sword'],
      secondary: false,
    });
  });

  it('throws when the checkpoint has no round-0 baseline rows for its own incumbent anchor', () => {
    const checkpoint = legacyCheckpointWithPanel([1], ['sword']);
    // Simulate a corrupted/foreign checkpoint whose rows never match its own
    // incumbentCombo/incumbentConfigId anchor.
    const corrupted: RoundCheckpoint = { ...checkpoint, rows: [] };
    expect(() => inferRunInputsFromCheckpoint(corrupted)).toThrow(/no round-0 baseline rows found/);
  });

  it('infers secondary=true from a checkpoint whose steps contain ALL of SECONDARY_KNOBS', () => {
    const fullSecondaryKnobs: TunableKnob[] = [...KNOBS, ...SECONDARY_KNOBS];
    const checkpoint = initCheckpoint(LEGACY_LEGACY, fullSecondaryKnobs, baselineShard(150));
    expect(inferRunInputsFromCheckpoint(checkpoint).secondary).toBe(true);
  });

  it('fails closed (does not guess) on a PARTIAL secondary-knobs key set — this is the exact `.some()` unsoundness the all-or-none check replaces: one stray secondary key must never be treated as proof of a full secondary-knobs search', () => {
    const partialSecondaryKnobs: TunableKnob[] = [...KNOBS, SECONDARY_KNOBS[0]!];
    const checkpoint = initCheckpoint(LEGACY_LEGACY, partialSecondaryKnobs, baselineShard(150));
    expect(() => inferRunInputsFromCheckpoint(checkpoint)).toThrow(
      /PARTIAL secondary-knobs key set/,
    );
  });

  it("still requires the OWN panel (not just the incumbent's) to be complete/duplicate-free/rectangular — a non-LEGACY checkpoint whose own combo's rows are ragged fails on its own panel before the incumbent panel is even derived", () => {
    const navmeshBase = baseConfigForCombo(LEGACY_LEGACY);
    const navmeshBaseId = configId(navmeshBase);
    // Own combo: ragged (2 seeds x 2 weapons expected = 4 rows, but only 3 present).
    const raggedOwnShard = shard(
      [
        row(navmeshBaseId, 'sword', 1, 100, true, LEGACY_COMBO_ID),
        row(navmeshBaseId, 'bow', 1, 100, true, LEGACY_COMBO_ID),
        row(navmeshBaseId, 'sword', 2, 100, true, LEGACY_COMBO_ID),
      ],
      { [navmeshBaseId]: navmeshBase },
    );
    const checkpoint = initCheckpoint(
      LEGACY_LEGACY,
      KNOBS,
      raggedOwnShard,
      legacyPanelShard([1, 2], ['sword', 'bow']),
    );
    expect(() => inferRunInputsFromCheckpoint(checkpoint)).toThrow(
      /do not form a complete rectangular panel/,
    );
  });
});

describe('normalizeResumedCheckpoint (re-stamp workflowSha + packageLockHash on an ALREADY-accepted resume checkpoint)', () => {
  it("re-stamps meta.workflowSha to the expected (current run) value when the checkpoint carries the PRIOR run's workflowSha", () => {
    const checkpoint = legacyCheckpointWithPanel([1, 2, 3], ['sword', 'bow']);
    expect(checkpoint.meta.workflowSha).toBe(META.workflowSha);
    const expectedMeta: ShardMeta = { ...META, workflowSha: 'currentrunsha0000currentrunsha00' };
    const normalized = normalizeResumedCheckpoint(checkpoint, expectedMeta);
    expect(normalized.meta.workflowSha).toBe('currentrunsha0000currentrunsha00');
    // Every other meta field and the rows/steps/combo must be unchanged --
    // this is a workflowSha/packageLockHash-only re-stamp, not a general
    // meta rewrite.
    expect(normalized.meta).toEqual({ ...checkpoint.meta, workflowSha: expectedMeta.workflowSha });
    expect(normalized.rows).toBe(checkpoint.rows);
    expect(normalized.steps).toBe(checkpoint.steps);
  });

  it("re-stamps meta.packageLockHash to the expected (current run) value when the checkpoint carries the PRIOR run's packageLockHash", () => {
    const checkpoint = legacyCheckpointWithPanel([1, 2, 3], ['sword', 'bow']);
    expect(checkpoint.meta.packageLockHash).toBe(META.packageLockHash);
    const expectedMeta: ShardMeta = {
      ...META,
      packageLockHash: 'currentlockhash0000currentlock00',
    };
    const normalized = normalizeResumedCheckpoint(checkpoint, expectedMeta);
    expect(normalized.meta.packageLockHash).toBe('currentlockhash0000currentlock00');
    expect(normalized.meta).toEqual({
      ...checkpoint.meta,
      packageLockHash: expectedMeta.packageLockHash,
    });
    expect(normalized.rows).toBe(checkpoint.rows);
    expect(normalized.steps).toBe(checkpoint.steps);
  });

  it('re-stamps BOTH workflowSha and packageLockHash together when both differ from the expected (current run) values', () => {
    const checkpoint = legacyCheckpointWithPanel([1, 2, 3], ['sword', 'bow']);
    const expectedMeta: ShardMeta = {
      ...META,
      workflowSha: 'currentrunsha0000currentrunsha00',
      packageLockHash: 'currentlockhash0000currentlock00',
    };
    const normalized = normalizeResumedCheckpoint(checkpoint, expectedMeta);
    expect(normalized.meta.workflowSha).toBe(expectedMeta.workflowSha);
    expect(normalized.meta.packageLockHash).toBe(expectedMeta.packageLockHash);
  });

  it('is a no-op (returns the SAME object reference) when workflowSha AND packageLockHash already match', () => {
    const checkpoint = legacyCheckpointWithPanel([1, 2, 3], ['sword', 'bow']);
    const expectedMeta: ShardMeta = {
      ...META,
      workflowSha: checkpoint.meta.workflowSha,
      packageLockHash: checkpoint.meta.packageLockHash,
    };
    expect(normalizeResumedCheckpoint(checkpoint, expectedMeta)).toBe(checkpoint);
  });

  it('re-stamps (is NOT a no-op) when workflowSha matches but packageLockHash alone differs', () => {
    const checkpoint = legacyCheckpointWithPanel([1, 2, 3], ['sword', 'bow']);
    const expectedMeta: ShardMeta = {
      ...META,
      workflowSha: checkpoint.meta.workflowSha,
      packageLockHash: 'currentlockhash0000currentlock00',
    };
    const normalized = normalizeResumedCheckpoint(checkpoint, expectedMeta);
    expect(normalized).not.toBe(checkpoint);
    expect(normalized.meta.packageLockHash).toBe('currentlockhash0000currentlock00');
  });
});

describe("resolveInitRunInputs (--mode init's --train-seeds/--weapons CLI-flag pairing)", () => {
  it('returns undefined when neither --train-seeds nor --weapons is supplied (deliberately legacy)', () => {
    expect(resolveInitRunInputs(undefined, undefined, false)).toBeUndefined();
  });

  it('returns a populated runInputs record when both flags are supplied', () => {
    expect(resolveInitRunInputs('1,2,3', 'sword,bow', true)).toEqual({
      trainSeeds: '1,2,3',
      weapons: 'sword,bow',
      secondary: true,
    });
  });

  it('rejects --train-seeds without --weapons (one-present/one-missing)', () => {
    expect(() => resolveInitRunInputs('1,2,3', undefined, false)).toThrow(
      /--train-seeds and --weapons together/,
    );
  });

  it('rejects --weapons without --train-seeds (one-present/one-missing)', () => {
    expect(() => resolveInitRunInputs(undefined, 'sword,bow', false)).toThrow(
      /--train-seeds and --weapons together/,
    );
  });
});

describe('buildResumeLineageArtifact (durable viewer lineage contract)', () => {
  it('returns the exact resume-lineage payload shape for a positive integer run id', () => {
    expect(buildResumeLineageArtifact('29786216369')).toEqual({
      schemaVersion: 1,
      kind: 'resume',
      sourceRunId: 29_786_216_369,
    });
  });

  it('returns null for a blank resume_run_id so the workflow can skip upload on a fresh run', () => {
    expect(buildResumeLineageArtifact('')).toBeNull();
    expect(buildResumeLineageArtifact('   ')).toBeNull();
    expect(buildResumeLineageArtifact(undefined)).toBeNull();
  });

  it('returns null for a non-positive-integer resume_run_id so lineage emission stays additive-only', () => {
    expect(buildResumeLineageArtifact('0')).toBeNull();
    expect(buildResumeLineageArtifact('-7')).toBeNull();
    expect(buildResumeLineageArtifact('abc')).toBeNull();
    expect(buildResumeLineageArtifact('12.5')).toBeNull();
  });
});

describe('extractLegacyBaselineShard (derive a fresh legacy+legacy baseline shard from a resumed checkpoint)', () => {
  it('extracts the canonical LEGACY config + its rows from a legacy+legacy checkpoint', () => {
    const checkpoint = legacyCheckpointWithPanel([1, 2], ['sword']);
    const extracted = extractLegacyBaselineShard(checkpoint);
    expect(Object.keys(extracted.configs)).toEqual([BASE_ID]);
    expect(extracted.configs[BASE_ID]).toEqual(BASE);
    expect(extracted.rows).toHaveLength(2);
    expect(
      extracted.rows.every((r) => r.combo === 'riskRewardFused+legacy' && r.configId === BASE_ID),
    ).toBe(true);
  });

  it('rejects a checkpoint whose combo does not match the canonical LEGACY combo ID', () => {
    const checkpoint = initCheckpoint(LEGACY_LEGACY, KNOBS, baselineShard(150));
    // Directly set a non-canonical combo to verify the guard fires.
    const fakeCheckpoint = { ...checkpoint, combo: 'some-other-combo+mode' } as typeof checkpoint;
    expect(() => extractLegacyBaselineShard(fakeCheckpoint)).toThrow(/checkpoint combo must be/);
  });

  it('rejects a legacy+legacy checkpoint whose round-0 config is not the canonical LEGACY base', () => {
    const wrongConfig: SweepConfig = { ...BASE, aggression: (BASE.aggression ?? 0) + 0.5 };
    const wrongConfigId = configId(wrongConfig);
    const checkpoint = initCheckpoint(
      LEGACY_LEGACY,
      KNOBS,
      shard([row(wrongConfigId, 'sword', 1, 100)], { [wrongConfigId]: wrongConfig }),
    );
    expect(() => extractLegacyBaselineShard(checkpoint)).toThrow(
      /does not contain the canonical incumbent base config/,
    );
  });
});
