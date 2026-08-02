import { describe, expect, it } from 'vitest';
import { selectSpellBrokerDialogue } from '../../src/shared/npc-types.js';

/** A "nothing started" baseline; spread + override per case. */
const NONE = {
  locked: false,
  spellbookClaimed: false,
} as const;

describe('selectSpellBrokerDialogue', () => {
  it('returns null (use default authored dialogue) when unlocked and unclaimed', () => {
    expect(selectSpellBrokerDialogue(NONE)).toBeNull();
  });

  it('returns the locked line while the Goon has not cleared the player', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, locked: true })).toEqual([
      "Not yet. The Goon clears you, the Merchant dresses you, *then* you're my problem. That's the order.",
      "I didn't write the order. I'd have written it differently. I'd have written a lot of things differently.",
    ]);
  });

  it('returns the post-claim line once the spellbook is claimed', () => {
    expect(selectSpellBrokerDialogue({ ...NONE, spellbookClaimed: true })).toEqual([
      "It's live. It'll fire itself when the conditions are right — stop babysitting it and go fight.",
      "You know what the worst part is? I *like* them. Both of them. I've liked them for more seasons than he can count, and he used to be able to count. Go on. Kill something.",
    ]);
  });

  it('prioritises the locked line over the post-claim line', () => {
    expect(selectSpellBrokerDialogue({ locked: true, spellbookClaimed: true })).toEqual([
      "Not yet. The Goon clears you, the Merchant dresses you, *then* you're my problem. That's the order.",
      "I didn't write the order. I'd have written it differently. I'd have written a lot of things differently.",
    ]);
  });
});
