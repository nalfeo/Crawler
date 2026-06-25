import { describe, expect, it } from 'vitest';
import {
  selectTutorialGoonDialogue,
  TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE,
  TUTORIAL_GOON_NUDGE_DIALOGUE,
  TUTORIAL_GOON_POST_BOSS_DIALOGUE,
  type TutorialGoonDialogueState,
} from '../../src/shared/npc-types.js';

/** A "nothing started" baseline; spread + override per case. */
const NONE: TutorialGoonDialogueState = {
  bossDefeated: false,
  leaveFloorAccepted: false,
  goonGrindComplete: false,
  merchantErrandComplete: false,
  spellBrokerComplete: false,
};

describe('selectTutorialGoonDialogue', () => {
  it('returns null (use default authored dialogue) when nothing is complete', () => {
    expect(selectTutorialGoonDialogue(NONE)).toBeNull();
  });

  it('nudges toward the merchant + spell broker once the grind is done but the door is still sealed', () => {
    expect(selectTutorialGoonDialogue({ ...NONE, goonGrindComplete: true })).toBe(
      TUTORIAL_GOON_NUDGE_DIALOGUE,
    );
  });

  it('keeps nudging when only one of the other two gate quests is done', () => {
    expect(
      selectTutorialGoonDialogue({
        ...NONE,
        goonGrindComplete: true,
        merchantErrandComplete: true,
      }),
    ).toBe(TUTORIAL_GOON_NUDGE_DIALOGUE);
    expect(
      selectTutorialGoonDialogue({
        ...NONE,
        goonGrindComplete: true,
        spellBrokerComplete: true,
      }),
    ).toBe(TUTORIAL_GOON_NUDGE_DIALOGUE);
  });

  it('stops nudging when all three gate quests are done (awaiting auto-accept)', () => {
    expect(
      selectTutorialGoonDialogue({
        ...NONE,
        goonGrindComplete: true,
        merchantErrandComplete: true,
        spellBrokerComplete: true,
      }),
    ).toBeNull();
  });

  it('announces the finale when the "Leave the Floor" quest is accepted', () => {
    expect(
      selectTutorialGoonDialogue({
        ...NONE,
        goonGrindComplete: true,
        merchantErrandComplete: true,
        spellBrokerComplete: true,
        leaveFloorAccepted: true,
      }),
    ).toBe(TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE);
  });

  it('prioritises the leave-the-floor line over the nudge', () => {
    // leaveFloorAccepted wins even if the gate booleans would otherwise nudge.
    expect(
      selectTutorialGoonDialogue({
        ...NONE,
        goonGrindComplete: true,
        leaveFloorAccepted: true,
      }),
    ).toBe(TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE);
  });

  it('prioritises the post-boss line above everything else', () => {
    expect(
      selectTutorialGoonDialogue({
        bossDefeated: true,
        leaveFloorAccepted: true,
        goonGrindComplete: true,
        merchantErrandComplete: true,
        spellBrokerComplete: true,
      }),
    ).toBe(TUTORIAL_GOON_POST_BOSS_DIALOGUE);
  });
});
