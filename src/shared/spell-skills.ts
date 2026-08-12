import { FLOOR1_BOSS_REWARD_SPELL_IDS, type Floor1BossRewardSpellId } from './abilities.js';
import { FLOOR1_SPELL_BROKER_COST } from './constants.js';
import { hashStringToSeed, SeededRandom } from './random.js';
import type { Floor1SpellBrokerOffer } from './floor-types.js';

/** One usage skill is attached to every spell in the Floor 1 catalog. */
export const SPELL_SKILL_ID_BY_SPELL_ID: Readonly<Record<Floor1BossRewardSpellId, string>> = {
  fireball: 'spell-fireball',
  heal: 'spell-heal',
  'pulse-shield': 'spell-pulse-shield',
  'magic-missile': 'spell-magic-missile',
  'frost-nova': 'spell-frost-nova',
  bless: 'spell-bless',
  stoneskin: 'spell-stoneskin',
  curse: 'spell-curse',
  'vampiric-touch': 'spell-vampiric-touch',
  haste: 'spell-haste',
};

export const SPELL_SKILL_IDS = FLOOR1_BOSS_REWARD_SPELL_IDS.map(
  (spellId) => SPELL_SKILL_ID_BY_SPELL_ID[spellId],
) as readonly string[];

export function getSpellSkillId(spellId: string): string | undefined {
  return (SPELL_SKILL_ID_BY_SPELL_ID as Record<string, string | undefined>)[spellId];
}

export const FLOOR1_SPELL_BROKER_OFFER_COUNT = 3;

/** Generate the broker's single-purchase stock without consuming gameplay RNG. */
export function generateFloor1SpellBrokerOffers(seed: number): Floor1SpellBrokerOffer[] {
  const rng = new SeededRandom(hashStringToSeed(`${seed}:floor1-spell-broker`));
  const pool = [...FLOOR1_BOSS_REWARD_SPELL_IDS];
  const offers: Floor1SpellBrokerOffer[] = [];
  while (pool.length > 0 && offers.length < FLOOR1_SPELL_BROKER_OFFER_COUNT) {
    const index = rng.nextInt(0, pool.length - 1);
    const spellId = pool.splice(index, 1)[0];
    if (spellId !== undefined) {
      offers.push({ spellId, cost: FLOOR1_SPELL_BROKER_COST, purchased: false });
    }
  }
  return offers;
}
