import { describe, expect, it } from 'vitest';

import { scoreSetPiece } from '../../../scripts/agent/set-piece/composition-score.js';
import { validateWelcomeRoomV2Evidence } from '../../../scripts/agent/set-piece/pilot-evidence.js';
import {
  getSetPieceDef,
  installDefaultSetPiecePacks,
} from '../../../src/shared/set-piece-types.js';

describe('welcome-room-v2 lookbook evidence pilot', () => {
  it('validates the structured brief, geometry, grounding, and evidence contract', () => {
    const evidence = validateWelcomeRoomV2Evidence();

    expect(evidence.zones).toHaveLength(4);
    expect(evidence.grounding.corePack.length).toBeGreaterThanOrEqual(3);
    expect(evidence.lore.canonSources).toHaveLength(4);
    expect(evidence.narrativeVerb).toContain('former contestant');
    expect(evidence.evidence.subjectiveReview).toBe('advisory');
    expect(evidence.preRenderTarget.stage).toBe('pre-decomposition');
    expect(evidence.preRenderTarget.decomposition).toBe('pending');
    expect(evidence.preRenderTarget.circulation.minimumWidthTiles).toBe(2);
  });

  it('rejects a vignette that drifts from authored room data', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        vignettes: [
          {
            ...valid.vignettes[0],
            propIds: ['invented-prop'],
          },
          valid.vignettes[1],
        ],
      }),
    ).toThrow('references missing prop');
  });

  it('rejects a pre-render target whose protected negative space drifts from the room zones', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        preRenderTarget: {
          ...valid.preRenderTarget,
          negativeSpace: {
            ...valid.preRenderTarget.negativeSpace,
            zoneId: 'invented-zone',
          },
        },
      }),
    ).toThrow('negative-space zone');
  });

  it('rejects a pre-render focal mass outside the authored footprint', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        preRenderTarget: {
          ...valid.preRenderTarget,
          focal: {
            ...valid.preRenderTarget.focal,
            boundsFeet: {
              ...valid.preRenderTarget.focal.boundsFeet,
              x: 28,
            },
          },
        },
      }),
    ).toThrow('focal bounds extend outside');
  });

  it('rejects a pre-render focal mass outside the zone it claims', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        preRenderTarget: {
          ...valid.preRenderTarget,
          focal: {
            ...valid.preRenderTarget.focal,
            boundsFeet: { ...valid.preRenderTarget.focal.boundsFeet, x: 12 },
          },
        },
      }),
    ).toThrow('focal bounds extend outside zone "broker-alcove"');
  });

  it('rejects a pre-render canvas that misstates the projection scale', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        preRenderTarget: {
          ...valid.preRenderTarget,
          canvas: { ...valid.preRenderTarget.canvas, scale: 'native-1x' },
        },
      }),
    ).toThrow('contradicts its scale factor');
  });

  it('rejects a pre-render target whose visual asset is missing', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        preRenderTarget: {
          ...valid.preRenderTarget,
          visualAsset: 'src/shared/data/set-piece-evidence/does-not-exist.svg',
        },
      }),
    ).toThrow('does not exist');
  });

  it('rejects a circulation route node that is neither a zone nor an anchor', () => {
    const valid = validateWelcomeRoomV2Evidence();
    expect(() =>
      validateWelcomeRoomV2Evidence({
        ...valid,
        preRenderTarget: {
          ...valid.preRenderTarget,
          circulation: {
            ...valid.preRenderTarget.circulation,
            route: ['door-entry', 'invented-zone'],
          },
        },
      }),
    ).toThrow('circulation node "invented-zone"');
  });
});

/**
 * Ratchet for the pilot room itself.
 *
 * `welcome-room-composition.test.ts` pins only `welcome-room`, so without this
 * the pilot's 12/12 composition result — including the circulation gain from
 * clearing the central route — could silently regress. If this goes red, fix
 * the room with `npm run setpiece:score -- --id welcome-room-v2`; do not lower
 * the bar (repo rule #11).
 */
describe('welcome-room-v2 composition ratchet', () => {
  installDefaultSetPiecePacks();
  const def = getSetPieceDef('welcome-room-v2');

  it('is present in the shipped set-piece definitions', () => {
    expect(def).toBeDefined();
  });

  it('passes every composition check', () => {
    const report = scoreSetPiece(def!);
    const failed = report.checks.filter((check) => !check.pass);

    expect(
      failed.map((check) => `${check.id}: ${check.detail}`),
      'welcome-room-v2 is the grounded pilot room and must stay at a full pass',
    ).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
