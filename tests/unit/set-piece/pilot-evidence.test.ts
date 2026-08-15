import { describe, expect, it } from 'vitest';

import { validateWelcomeRoomV2Evidence } from '../../../scripts/agent/set-piece/pilot-evidence.js';

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
});
