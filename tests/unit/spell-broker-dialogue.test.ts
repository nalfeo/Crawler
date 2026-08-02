import { describe, expect, it } from 'vitest';
import {
  selectSpellBrokerDialogue,
  SPELL_BROKER_POST_CLAIM_DIALOGUE,
  SPELL_QUEST_GIVER_LOCKED_DIALOGUE,
  type SpellBrokerDialogueState,
} from '../../src/shared/npc-types.js';

/** A "nothing started" baseline; spread + override per case. */
const NONE: SpellBrokerDialogueState = {
  locked: false,
  spellbookClaimed: false,
};

describe('selectSpellBrokerDialogue', () => {
  it('returns null (use default authored dialogue) when unlocked and unclaimed', () => {
    expect(selectSpellBrokerDialogue(NONE)).toBeNull();
  });

  it('returns the locked line while the Goon has not cleared the player', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, locked: true })).toBe(
      SPELL_QUEST_GIVER_LOCKED_DIALOGUE,
    );
  });

  it('returns the post-claim line once the spellbook is claimed', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, spellbookClaimed: true })).toBe(
      SPELL_BROKER_POST_CLAIM_DIALOGUE,
    );
  });

  it('prioritises the locked line over the post-claim line', () => {
    expect(selectSpellBrokerDialogue({ locked: true, spellbookClaimed: true })).toBe(
      SPELL_QUEST_GIVER_LOCKED_DIALOGUE,
    );
  });
});
