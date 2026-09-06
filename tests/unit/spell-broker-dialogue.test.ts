import { describe, expect, it } from 'vitest';
import { selectSpellBrokerDialogue } from '../../src/shared/npc-types.js';

/** A "nothing started" baseline; spread + override per case. */
const NONE = {
  locked: false,
  bossDefeated: false,
  spellbookClaimed: false,
  merchantQuestStarted: false,
} as const;

describe('selectSpellBrokerDialogue', () => {
  it('omits only the tail-reference line until the merchant quest is active', () => {
    expect(selectSpellBrokerDialogue(NONE)).toEqual([
      "I handle the part the other two can't teach you: the moment where hitting harder stops being enough. Kill the Slime Rat, come back, I'll unseal a spellbook.",
      "You'll be offered three. Pick fast and *use* it. A spell you're saving for the perfect moment is a spell they find unused on your body. Ask me how I know what unused looks like.",
    ]);
  });

  it('allows the default authored dialogue once the merchant quest is active', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, merchantQuestStarted: true })).toBeNull();
  });

  it('returns the locked line while the Goon has not cleared the player', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, locked: true })).toEqual([
      "Not yet. The Goon clears you, the Merchant dresses you, *then* you're my problem. That's the order.",
      "I didn't write the order. I'd have written it differently. I'd have written a lot of things differently.",
    ]);
  });

  it('returns the post-boss progression line once the Slime Rat objective is complete', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, bossDefeated: true })).toEqual([
      "You'll be offered three. Pick fast and *use* it. A spell you're saving for the perfect moment is a spell they find unused on your body. Ask me how I know what unused looks like.",
    ]);
  });

  it('returns the post-claim line once the spellbook is claimed', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, spellbookClaimed: true })).toEqual([
      "It's live. It'll fire itself when the conditions are right — stop babysitting it and go fight.",
      "You know what the worst part is? I *like* them. Both of them. I've liked them for more seasons than he can count, and he used to be able to count. Go on. Kill something.",
    ]);
  });

  it('prioritises the locked line over the post-claim and post-boss lines', () => {
    expect(
      selectSpellBrokerDialogue({
        locked: true,
        bossDefeated: true,
        spellbookClaimed: true,
        merchantQuestStarted: false,
      }),
    ).toEqual([
      "Not yet. The Goon clears you, the Merchant dresses you, *then* you're my problem. That's the order.",
      "I didn't write the order. I'd have written it differently. I'd have written a lot of things differently.",
    ]);
  });
});
