/**
 * Unit coverage for `selectSearchPromotion` — the legacy `--stage search`
 * hill-climb's round-to-round promotion gate in
 * `scripts/agent/perf/sweep-eval.ts` — and `assertLegacyBaselineProvenance`,
 * which vets an externally-loaded `--legacy-baseline` artifact before it is
 * injected as the search's fixed incumbent.
 *
 * A multi-model review round (gpt-5.3-codex) found this legacy local-smoke
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
 * `selectSearchPromotion`) gated non-LEGACY combos against their OWN baseline
 * instead of the fixed LEGACY+LEGACY incumbent `round-plan.ts`'s production
 * path always uses — `selectSearchPromotion` gained an `incumbentCombo` param
 * to fix this (tested above). A further review round flagged that the
 * optional `--legacy-baseline` artifact (an optimization to reuse one LEGACY
 * shard across multiple combo searches) was consumed with no provenance
 * check, so a stale/wrong-floor/pre-v2 baseline could silently seed a
 * mis-calibrated incumbent — `assertLegacyBaselineProvenance` closes that gap
 * (tested below).
 */
import { describe, expect, it } from 'vitest';
import {
  assertLegacyBaselineProvenance,
  currentBuildFingerprint,
  selectSearchPromotion,
} from '../../../scripts/agent/perf/sweep-eval.js';
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

  it('non-LEGACY combo: correctly gates against LEGACY incumbent when incumbentCombo is provided (regression for GH review finding — navmesh+legacy wins vs legacy+legacy, not vs own baseline)', () => {
    // Scenario: navmesh+legacy combo. The LEGACY incumbent (legacy+legacy /
    // legacy-base config) wins 9/10 seeds. The navmesh combo candidate wins
    // 10/10 seeds — strictly more than the LEGACY incumbent.
    // Without threading incumbentCombo='legacy+legacy', buildLeaderboard
    // would look for combo='navmesh+legacy' / configId='legacy-base' and find
    // no rows, making winsVsIncumbentDelta null and disqualifying the candidate.
    const NAVMESH_COMBO = 'navmeshFused+slackAware';
    const LEGACY_COMBO = 'legacy+legacy';

    const rows: RunRow[] = [];
    // LEGACY incumbent rows (tagged with legacy combo, legacy configId).
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

  it('non-LEGACY combo: disqualifies when incumbentCombo is omitted and incumbent rows carry legacy combo tag (gate sees no incumbent → null delta)', () => {
    // Same setup as the passing test above, but omitting incumbentCombo.
    // buildLeaderboard looks for combo='navmesh+legacy' / 'legacy-base' and
    // finds no rows → winsVsIncumbentDelta null → candidate disqualified.
    // This confirms that incumbentCombo must be threaded for non-LEGACY combos.
    const NAVMESH_COMBO = 'navmeshFused+slackAware';
    const LEGACY_COMBO = 'legacy+legacy';

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
  const LEGACY_COMBO = 'legacy+legacy';
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
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 3; seed++) {
      rows.push(row({ combo: LEGACY_COMBO, configId: 'legacy-base', weapon: 'sword', seed }));
    }
    return {
      meta: VALID_META,
      configs: { 'legacy-base': {} as never },
      rows,
    };
  }

  it('accepts a well-formed --legacy-baseline artifact and returns its sole configId', () => {
    expect(assertLegacyBaselineProvenance(validArtifact(), EXPECTED)).toBe('legacy-base');
  });

  it('rejects an artifact with more than one config', () => {
    const artifact = validArtifact();
    artifact.configs['legacy-base-2'] = {} as never;
    expect(() => assertLegacyBaselineProvenance(artifact, EXPECTED)).toThrow(/exactly one config/);
  });

  it('rejects an artifact whose rows are not all tagged the LEGACY combo', () => {
    const artifact = validArtifact();
    artifact.rows.push(
      row({ combo: 'navmeshFused+slackAware', configId: 'legacy-base', weapon: 'sword', seed: 4 }),
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
});

describe('currentBuildFingerprint', () => {
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
});
