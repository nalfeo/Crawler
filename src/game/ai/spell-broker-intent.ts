import type { GameWorld } from '../../core/world.js';
import { generateFloor1SpellBrokerOffers } from '../../shared/spell-skills.js';
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';

export const SPELL_BROKER_AI_PURCHASE_CHANCE = 0.25;

export interface SpellBrokerIntent {
  readonly enabled: boolean;
  readonly decisionMade: boolean;
  readonly shouldBuy: boolean;
  readonly spellId: string | null;
  readonly cost: number;
}

const intents = new WeakMap<GameWorld, SpellBrokerIntent>();

function initialIntent(enabled: boolean): SpellBrokerIntent {
  return { enabled, decisionMade: false, shouldBuy: false, spellId: null, cost: 0 };
}

export function configureSpellBrokerPurchase(world: GameWorld, enabled: boolean): void {
  const current = intents.get(world);
  intents.set(world, current ? { ...current, enabled } : initialIntent(enabled));
}

export function getSpellBrokerIntent(world: GameWorld): SpellBrokerIntent {
  return intents.get(world) ?? initialIntent(false);
}

/**
 * Make one seed-derived decision. A per-key seed keeps the 25% choice stable
 * without consuming the combat RNG stream or changing equipment behavior.
 */
export function ensureSpellBrokerDecision(world: GameWorld): SpellBrokerIntent {
  const current = getSpellBrokerIntent(world);
  if (!current.enabled || current.decisionMade) return current;
  const roll = new SeededRandom(hashStringToSeed(`${world.seed}:spell-broker-ai-intent`)).next();
  const shouldBuy = roll < SPELL_BROKER_AI_PURCHASE_CHANCE;
  const offer = generateFloor1SpellBrokerOffers(world.seed)[0];
  const next: SpellBrokerIntent = {
    ...current,
    decisionMade: true,
    shouldBuy,
    spellId: shouldBuy ? (offer?.spellId ?? null) : null,
    cost: shouldBuy ? (offer?.cost ?? 0) : 0,
  };
  intents.set(world, next);
  return next;
}
