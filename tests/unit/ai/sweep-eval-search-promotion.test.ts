/**
 * Unit coverage for `selectSearchPromotion` — the `--stage search`
 * hill-climb's round-to-round promotion gate in
 * `scripts/agent/perf/sweep-eval.ts` — and `assertLegacyBaselineProvenance`,
 * which vets an externally-loaded `--legacy-baseline` artifact before it is
 * injected as the search's fixed incumbent.
 *
 * A multi-model review round (gpt-5.3-codex) found this local-smoke
 * path still promoted candidates by raw composite score alone
 * (`totalScoreOf`), never routing through `selectQualifiedWinner`'s hard
 * safety gate — reintroducing the exact GH-run-29597840666 bug class in the
 * local path instead of CI. `selectSearchPromotion` was extracted as a pure
 * function so the shared gate (human-approved net-win rule: >=90% official
 * wins AND strictly more total wins than the incumbent — win→loss flips
 * alone are no longer disqualifying) is locked in without needing to run
 * headless games.
 *
 * A later review round found `searchCombo` (the caller of
 * `selectSearchPromotion`) gated non-incumbent combos against their OWN baseline
 * instead of the fixed `riskRewardFused+legacy` incumbent `round-plan.ts`'s production
 * path always uses — `selectSearchPromotion` gained an `incumbentCombo` param
 * to fix this (tested above). A further review round flagged that the
 * optional `--legacy-baseline` artifact (an optimization to reuse one incumbent
 * shard across multiple combo searches) was consumed with no provenance
 * check, so a stale/wrong-floor/pre-v2 baseline could silently seed a
 * mis-calibrated incumbent — `assertLegacyBaselineProvenance` closes that gap
 * (tested below).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLegacyBaselineProvenance,
  buildMeta,
  currentBuildFingerprint,
  selectSearchPromotion,
  STANDALONE_SHARD_STAGE,
} from '../../../scripts/agent/perf/sweep-eval.js';
import { baseConfigForCombo, configId } from '../../../scripts/agent/perf/gen-configs.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';
import {
  SHARD_SCHEMA_VERSION,
  type RunRow,
  type ShardArtifact,
  type ShardMeta,
} from '../../../scripts/agent/perf/aggregate-shards.js';

const VICTORY_SCORE = 1_000_000;
const BUDGET_MS = 360_000;

function row(
  partial: Partial<RunRow> & Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>,
): RunRow {
  return {
    outcome: 'victory',
    officialWin: true,
    gameTimeMs: 100_000,
    safeRoomMs: 0,
    score: VICTORY_SCORE,
    xp: 100,
    gold: 50,
    minHealthPercent: 0.5,
    finalLevel: 5,
    ...partial,
  };
}

function loss(
  partial: Partial<RunRow> & Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>,
): RunRow {
  return row({
    outcome: 'timeout',
    officialWin: false,
    gameTimeMs: 396_000,
    score: 30,
    ...partial,
  });
}

const COMBO = 'legacy+legacy';

describe('selectSearchPromotion', () => {
  it('rejects a flip-tainted candidate whose total wins only TIE the incumbent (GH run 29597840666 shape, legacy search path)', () => {
    // Incumbent (base.id): wins seeds 1-9, loses seed 10. Total wins = 9.
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: COMBO, configId: 'base', weapon: 'sword', seed })
          : row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }),
      );
    }
    // Candidate: flips seed 5 (win→loss) but also recovers seed 10 (loss→win),
    // netting to zero — its total wins (9) still only TIE the incumbent's (9),
    // not a strict increase — even though it clears the 90% win-rate floor and
    // scores much higher overall.
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        seed === 5
          ? loss({ combo: COMBO, configId: 'flip-tainted', weapon: 'sword', seed })
          : row({
              combo: COMBO,
              configId: 'flip-tainted',
              weapon: 'sword',
              seed,
              score: 5_000_000,
            }),
      );
    }
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['flip-tainted']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).toBeNull();
  });

  it('qualifies a flip-tainted candidate whose total wins STRICTLY EXCEED the incumbent (292/300 vs 286/300, 5 flips — GH run 29597840666, human-approved net-win rule)', () => {
    // Incumbent (base.id): wins seeds 1-286, loses seeds 287-300 (14 losses).
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      rows.push(
        seed <= 286
          ? row({ combo: COMBO, configId: 'base', weapon: 'sword', seed })
          : loss({ combo: COMBO, configId: 'base', weapon: 'sword', seed }),
      );
    }
    // Candidate: flips seeds 1-5 (was a win, now a loss) and recovers seeds
    // 287-297 (was a loss, now a win) => 286 - 5 + 11 = 292 total wins, 5
    // flips, but strictly MORE total wins than the incumbent's 286.
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const incumbentWins = seed <= 286;
      const flipped = seed >= 1 && seed <= 5;
      const recovered = seed >= 287 && seed <= 297;
      const candidateWins = (incumbentWins && !flipped) || (!incumbentWins && recovered);
      candidateRows.push(
        candidateWins
          ? row({ combo: COMBO, configId: 'net-win', weapon: 'sword', seed, score: 5_000_000 })
          : loss({ combo: COMBO, configId: 'net-win', weapon: 'sword', seed }),
      );
    }
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['net-win']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).not.toBeNull();
    expect(promotion?.bestId).toBe('net-win');
  });

  it('promotes a higher-scoring, strictly-more-wins qualifying candidate', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: COMBO, configId: 'base', weapon: 'sword', seed })
          : row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }),
      );
    }
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({ combo: COMBO, configId: 'qualified', weapon: 'sword', seed, score: 2_000_000 }),
      );
    }
    // Same panel, with seed 10 recovered: 10 wins, strictly more than the
    // incumbent's 9.
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['qualified']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).not.toBeNull();
    expect(promotion?.bestId).toBe('qualified');
    expect(promotion?.bestScore).toBe(2_000_000 * 10);
  });

  it('returns null when the only qualifying candidate does not out-score the current position', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }));
    }
    // Code-review finding: the candidate's extra bow/1 cell must also exist
    // in the incumbent's panel (as a loss) for winsVsIncumbentDelta to be
    // non-null — otherwise the candidate is disqualified by panel mismatch,
    // not by score, and this test stops exercising the score-comparison path.
    rows.push(loss({ combo: COMBO, configId: 'base', weapon: 'bow', seed: 1 }));
    // Qualifies (11 wins, strictly more than the incumbent's 10) but scores
    // LOWER than the current position — must not be promoted (caller should
    // halve steps instead).
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({ combo: COMBO, configId: 'lower-score', weapon: 'sword', seed, score: 10 }),
      );
    }
    candidateRows.push(
      row({ combo: COMBO, configId: 'lower-score', weapon: 'bow', seed: 1, score: 10 }),
    );
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['lower-score']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).toBeNull();
  });

  it('only considers rows in candidateIds, ignoring other configIds present in allRows', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }));
    }
    // A high-scoring, qualifying config NOT in candidateIds (e.g. from a prior
    // round) must be ignored — only this round's new neighbours are eligible.
    const staleRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      staleRows.push(
        row({
          combo: COMBO,
          configId: 'stale-prior-round',
          weapon: 'sword',
          seed,
          score: 9_000_000,
        }),
      );
    }
    const allRows = [...rows, ...staleRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['this-round-candidate-not-present']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).toBeNull();
  });

  it('non-incumbent combo: correctly gates against incumbent when incumbentCombo is provided (regression for GH review finding — challenger wins vs incumbent, not vs own baseline)', () => {
    // Scenario: challenger combo. The incumbent wins 9/10 seeds. The challenger wins
    // 10/10 seeds — strictly more than the incumbent.
    // Without threading incumbentCombo='riskRewardFused+legacy', buildLeaderboard
    // would look for combo='challenger' / configId='incumbent-base' and find
    // no rows, making winsVsIncumbentDelta null and disqualifying the candidate.
    const NAVMESH_COMBO = 'navmeshFused+slackAware';
    const LEGACY_COMBO = 'riskRewardFused+legacy';

    const rows: RunRow[] = [];
    // Incumbent rows (tagged with incumbent combo, incumbent configId).
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: LEGACY_COMBO, configId: 'legacy-base', weapon: 'sword', seed })
          : row({ combo: LEGACY_COMBO, configId: 'legacy-base', weapon: 'sword', seed }),
      );
    }
    // navmesh combo's own baseline (tagged with navmesh combo — not the gate reference).
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({
              combo: NAVMESH_COMBO,
              configId: 'navmesh-base',
              weapon: 'sword',
              seed,
            })
          : row({ combo: NAVMESH_COMBO, configId: 'navmesh-base', weapon: 'sword', seed }),
      );
    }
    // navmesh candidate: wins all 10 seeds (strictly more than LEGACY incumbent's 9).
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({
          combo: NAVMESH_COMBO,
          configId: 'navmesh-tuned',
          weapon: 'sword',
          seed,
          score: 2_000_000,
        }),
      );
    }
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      NAVMESH_COMBO,
      'legacy-base',
      new Set(['navmesh-tuned']),
      BUDGET_MS,
      'navmesh-base',
      LEGACY_COMBO,
    );

    expect(promotion).not.toBeNull();
    expect(promotion?.bestId).toBe('navmesh-tuned');
  });

  it('non-incumbent combo: disqualifies when incumbentCombo is omitted and incumbent rows carry incumbent combo tag (gate sees no incumbent → null delta)', () => {
    // Same setup as the passing test above, but omitting incumbentCombo.
    // buildLeaderboard looks for combo='challenger' / 'legacy-base' and
    // finds no rows → winsVsIncumbentDelta null → candidate disqualified.
    // This confirms that incumbentCombo must be threaded for non-incumbent combos.
    const NAVMESH_COMBO = 'navmeshFused+slackAware';
    const LEGACY_COMBO = 'riskRewardFused+legacy';

    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: LEGACY_COMBO, configId: 'legacy-base', weapon: 'sword', seed })
          : row({ combo: LEGACY_COMBO, configId: 'legacy-base', weapon: 'sword', seed }),
      );
    }
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: NAVMESH_COMBO, configId: 'navmesh-base', weapon: 'sword', seed })
          : row({ combo: NAVMESH_COMBO, configId: 'navmesh-base', weapon: 'sword', seed }),
      );
    }
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({
          combo: NAVMESH_COMBO,
          configId: 'navmesh-tuned',
          weapon: 'sword',
          seed,
          score: 2_000_000,
        }),
      );
    }
    const allRows = [...rows, ...candidateRows];

    // No incumbentCombo — defaults to NAVMESH_COMBO, so incumbent rows not found.
    const promotion = selectSearchPromotion(
      allRows,
      {},
      NAVMESH_COMBO,
      'legacy-base',
      new Set(['navmesh-tuned']),
      BUDGET_MS,
      'navmesh-base',
      // incumbentCombo intentionally omitted
    );

    expect(promotion).toBeNull();
  });
});

describe('assertLegacyBaselineProvenance', () => {
  const LEGACY_COMBO = 'riskRewardFused+legacy';
  // The declared config/id must be the CANONICAL incumbent base config — see the
  // "tuned riskRewardFused+legacy candidate" test below for the exact spoof this guards.
  const CANONICAL_LEGACY_ID = configId(
    baseConfigForCombo({
      pathing: AIPathingMode.RISK_REWARD_FUSED,
      decision: AIDecisionMode.LEGACY,
    }),
  );
  const VALID_META: ShardMeta = {
    schemaVersion: SHARD_SCHEMA_VERSION,
    budgetMs: BUDGET_MS,
    floorId: 'floor1',
    maxFrames: 23_760,
    stage: 'search',
    runnerOs: 'linux',
    nodeVersion: 'v22.0.0',
    packageLockHash: 'abc123def456abc123def456',
    workflowSha: 'deadbeefcafe0000deadbeefcafe0000',
  };
  const EXPECTED = {
    floorId: 'floor1',
    budgetMs: BUDGET_MS,
    maxFrames: 23_760,
    runnerOs: VALID_META.runnerOs,
    nodeVersion: VALID_META.nodeVersion,
    packageLockHash: VALID_META.packageLockHash,
    workflowSha: VALID_META.workflowSha,
  };

  function validArtifact(): ShardArtifact {
    const canonicalConfig = baseConfigForCombo({
      pathing: AIPathingMode.RISK_REWARD_FUSED,
      decision: AIDecisionMode.LEGACY,
    });
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 3; seed++) {
      rows.push(row({ combo: LEGACY_COMBO, configId: CANONICAL_LEGACY_ID, weapon: 'sword', seed }));
    }
    return {
      meta: VALID_META,
      configs: { [CANONICAL_LEGACY_ID]: canonicalConfig },
      rows,
    };
  }

  it('accepts a well-formed --legacy-baseline artifact and returns its sole configId', () => {
    expect(assertLegacyBaselineProvenance(validArtifact(), EXPECTED)).toBe(CANONICAL_LEGACY_ID);
  });

  it('rejects an artifact with more than one config', () => {
    const artifact = validArtifact();
    artifact.configs['extra-config-id'] = {} as never;
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/exactly one config/);
  });

  it('rejects an artifact whose rows are not all tagged the LEGACY combo', () => {
    const artifact = validArtifact();
    artifact.rows.push(
      row({
        combo: 'navmeshFused+slackAware',
        configId: CANONICAL_LEGACY_ID,
        weapon: 'sword',
        seed: 4,
      }),
    );
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(
      /must all be tagged combo/,
    );
  });

  it('rejects a pre-v2/stale schema version (would silently undercount the incumbent via raw-time fallback)', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, schemaVersion: SHARD_SCHEMA_VERSION - 1 };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/schema version/);
  });

  it('rejects a floorId mismatch', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, floorId: 'floor2' };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/floorId/);
  });

  it('rejects a budgetMs mismatch', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, budgetMs: BUDGET_MS + 1 };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/win-budget/);
  });

  it('rejects a maxFrames mismatch', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, maxFrames: 1 };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/frame-cap/);
  });

  it('rejects a --legacy-baseline artifact produced on a different runner OS', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, runnerOs: 'darwin-arm64' };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/runner-OS/);
  });

  it('rejects a --legacy-baseline artifact produced under a different Node runtime', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, nodeVersion: 'v18.0.0' };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/node-version/);
  });

  it('rejects a --legacy-baseline artifact produced against different dependencies (package-lock hash)', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, packageLockHash: 'stalehash0000stalehash0000' };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/package-lock/);
  });

  it('rejects a --legacy-baseline artifact produced by a different code revision (workflow SHA) — a stale baseline from a different build must not silently seed the incumbent', () => {
    const artifact = validArtifact();
    artifact.meta = { ...VALID_META, workflowSha: 'stalesha0000stalesha0000stalesha0' };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/workflow-sha/);
  });

  it('rejects a row missing safeRoomMs (pre-v2 row shape smuggled past a matching schemaVersion)', () => {
    const artifact = validArtifact();
    // Simulate a malformed/pre-v2 row that slipped past JSON.parse's type cast.
    (artifact.rows[0] as { safeRoomMs?: number }).safeRoomMs = undefined;
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/safeRoomMs/);
  });

  it('rejects rows that do not reference the artifact sole configId', () => {
    const artifact = validArtifact();
    const firstRow = artifact.rows[0]!;
    artifact.rows[0] = { ...firstRow, configId: 'wrong-config-id' };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(
      /must all reference the sole configId/,
    );
  });

  it('rejects a tuned riskRewardFused+legacy shard — only the canonical incumbent base config is a valid fixed incumbent', () => {
    // A `--stage search-eval` shard for a tuned riskRewardFused+legacy candidate has one
    // config, incumbent-tagged rows, and valid provenance — but its configId is NOT
    // the canonical incumbent base config. The fixed incumbent must be exactly the
    // canonical base, not a search-tuned variant of it.
    const tunedId = CANONICAL_LEGACY_ID + ',scanRadius=0.9500';
    const artifact: ShardArtifact = {
      meta: VALID_META,
      configs: { [tunedId]: {} as never },
      rows: [1, 2, 3].map((seed) =>
        row({ combo: LEGACY_COMBO, configId: tunedId, weapon: 'sword', seed }),
      ),
    };
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(
      /canonical incumbent base config/,
    );
  });

  it('rejects an artifact whose config body is a tuned variant stored under the canonical key — the canonical key alone is insufficient; the stored body itself must compute to the canonical id', () => {
    // A same-build artifact can be constructed where the dict key is the
    // canonical LEGACY ID string but the config BODY carries tuned values.
    // The key check (legacyId === canonicalLegacyConfigId) passes, but
    // configId(body) produces a different id, catching the tampered body.
    const artifact = validArtifact();
    const tunedBody = {
      ...baseConfigForCombo({
        pathing: AIPathingMode.RISK_REWARD_FUSED,
        decision: AIDecisionMode.LEGACY,
      }),
      aggression: 1.5,
    };
    artifact.configs[CANONICAL_LEGACY_ID] = tunedBody;
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(
      /config body does not match/,
    );
  });

  it("rejects an artifact whose config body is tuned by LESS than configId's 4-decimal rounding — configId() rounds every knob to 4dp for stable identity, so a body-vs-canonical check that compares configId strings (instead of raw values) would let a sub-4dp-tuned body slip through under the canonical key", () => {
    // configId() rounds aggression to 4dp (see gen-configs.ts `round4`), so a
    // body tuned by 0.00001 — below that resolution — computes to the
    // IDENTICAL configId as the canonical base even though the raw stored
    // value is not exactly canonical. An id-based body comparison cannot
    // distinguish these; only an exact (stableStringify) comparison of the
    // raw values can.
    const artifact = validArtifact();
    const canonicalBody = baseConfigForCombo({
      pathing: AIPathingMode.RISK_REWARD_FUSED,
      decision: AIDecisionMode.LEGACY,
    });
    const subDpTunedBody = { ...canonicalBody, aggression: canonicalBody.aggression! + 0.00001 };
    expect(configId(subDpTunedBody)).toBe(CANONICAL_LEGACY_ID); // same id, different raw value
    artifact.configs[CANONICAL_LEGACY_ID] = subDpTunedBody; // canonical key AND configId, tuned raw body
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(
      /config body does not match/,
    );
  });
});

describe('currentBuildFingerprint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("truncates nodeVersion to the major version only, matching setup-node's major-only pin", () => {
    // A multi-model review round flagged that comparing the FULL process.version
    // (e.g. 'v22.4.1') would spuriously reject an otherwise-valid same-run
    // shard the moment actions/setup-node@v4 resolves a different patch
    // release between jobs of the same multi-hour round-DAG workflow run —
    // .github/actions/setup-node only pins the major version ('22'). Truncating
    // to major-only ('v22') keeps a meaningful compatibility signal without
    // that false-rejection fragility.
    const fingerprint = currentBuildFingerprint();
    expect(fingerprint.nodeVersion).toMatch(/^v\d+$/);
    expect(fingerprint.nodeVersion).toBe(process.version.match(/^v\d+/)?.[0]);
  });

  it('reports runnerOs as platform-arch', () => {
    const fingerprint = currentBuildFingerprint();
    expect(fingerprint.runnerOs).toBe(`${process.platform}-${process.arch}`);
  });

  it('uses an explicit GITHUB_SHA when present', () => {
    vi.stubEnv('GITHUB_SHA', 'abc123');
    const fingerprint = currentBuildFingerprint();
    expect(fingerprint.workflowSha).toBe('abc123');
  });

  it('uses a local revision fingerprint instead of constant "local" when GITHUB_SHA is absent', () => {
    vi.stubEnv('GITHUB_SHA', '');
    const fingerprint = currentBuildFingerprint();
    expect(fingerprint.workflowSha).toMatch(/^local:[0-9a-f]+:[0-9a-f]{12}$/);
    expect(fingerprint.workflowSha).not.toBe('local');
  });
});

describe('STANDALONE_SHARD_STAGE', () => {
  // A cross-run resume review flagged that `sweep-eval.ts --print-meta`
  // (used by ai-sweep.yml's "Compute this run's expected provenance" step to
  // produce the `--expect-meta` JSON round-plan.ts's `resume-check` mode
  // compares against) defaults `--stage` to a *different* literal than what
  // `--stage search-baseline`/`--stage search-eval` stamp onto `meta.stage`
  // for the shards `initCheckpoint` folds into every round checkpoint — which
  // would make `assertResumeCompatible`'s strict `stage` equality check
  // reject every prior checkpoint and silently degrade `resume_run_id` to a
  // fresh run. Both call sites are pinned to the SAME exported constant so
  // they cannot drift independently; this test additionally pins the
  // constant's value so an accidental edit is caught here instead of only
  // failing a live GitHub Actions resume dispatch.
  it('is "search", matching parseArgs\' --print-meta default stage', () => {
    expect(STANDALONE_SHARD_STAGE).toBe('search');
  });

  it('produces a ShardMeta whose stage exactly matches buildMeta("search", ...)', () => {
    // Simulates: (1) --print-meta's output for THIS run, using the shared
    // constant exactly as parseArgs' default does; (2) a search-baseline/
    // search-eval shard's stamped meta, using the shared constant exactly as
    // evalStandalone's two call sites do. Both must be byte-identical on the
    // `stage` field for `assertResumeCompatible` to accept a prior checkpoint.
    const printMetaOutput = buildMeta(STANDALONE_SHARD_STAGE, 'floor1');
    const standaloneShardMeta = buildMeta(STANDALONE_SHARD_STAGE, 'floor1');
    expect(printMetaOutput.stage).toBe(standaloneShardMeta.stage);
    expect(printMetaOutput.stage).toBe('search');
  });

  it('records non-default XP measurement budgets in shard metadata', () => {
    const meta = buildMeta('xp-measure', 'floor2', {
      budgetMs: 1_666_666,
      maxFrames: 100_000,
    });

    expect(meta).toMatchObject({
      stage: 'xp-measure',
      floorId: 'floor2',
      budgetMs: 1_666_666,
      maxFrames: 100_000,
    });
  });
});
