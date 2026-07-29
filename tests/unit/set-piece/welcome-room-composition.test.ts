import { describe, expect, it } from 'vitest';

import { scoreSetPiece } from '../../../scripts/agent/set-piece/composition-score';
import { getSetPieceDef, installDefaultSetPiecePacks } from '../../../src/shared/set-piece-types';

/**
 * Ratchet for the reference set piece.
 *
 * `welcome-room` is the worked example the Set Piece Designer agent, the
 * `set-piece-dress` skill and the lookbook all point at: the one room that is
 * hand-curated rather than "AI slop". The other 12 set pieces currently score
 * 4-6/12, which is exactly the problem the composition gate exists to measure,
 * so `npm run setpiece:score` is deliberately NOT a blocking CI job — failing
 * the build on 12 known-bad rooms would be a false blocker that agents would
 * learn to route around.
 *
 * That leaves the reference room itself unprotected, and a reference that can
 * silently rot is worse than no reference. This test is the narrow ratchet: it
 * pins `welcome-room` at a full pass so any future edit that degrades it fails
 * a real, fast, deterministic check.
 *
 * If you are here because this test went red: fix the room, do not lower the
 * bar. Weakening the assertion to match a regressed room defeats the entire
 * point of having a reference implementation (repo rule #11). Re-dress with
 * `npm run setpiece:score -- --id welcome-room` until it is clean again.
 */
describe('welcome-room composition ratchet', () => {
  installDefaultSetPiecePacks();
  const def = getSetPieceDef('welcome-room');

  it('is present in the shipped set-piece definitions', () => {
    expect(def).toBeDefined();
  });

  it('passes every composition check', () => {
    const report = scoreSetPiece(def!);
    const failed = report.checks.filter((check) => !check.pass);

    // Name the failures in the message so a regression is actionable from CI
    // output alone, without re-running the scorer locally.
    expect(
      failed.map((check) => `${check.id}: ${check.detail}`),
      'welcome-room is the reference set piece and must stay at a full pass',
    ).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
