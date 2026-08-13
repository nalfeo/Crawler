import type { GameWorld } from '../../core/world.js';
import { generateFloor1SpellBrokerOffers } from '../../shared/spell-skills.js';
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';
import type { Floor1RunPlan } from './run-planner.js';

const SPELL_BROKER_AI_PURCHASE_CHANCE = 0.25;

/**
 * Lifecycle of the optional post-spellbook broker purchase.
 *
 * `idle`      — shouldBuy=true but spells not yet unlocked (pre-boss-battle).
 * `farming`   — spells unlocked, shouldBuy=true, gold < cost.
 * `returning` — spells unlocked, shouldBuy=true, gold >= cost.
 * `purchased` — purchase completed; goal cleared.
 * `abandoned` — run-planner dropped the bundle (deadline too tight).
 */
export type SpellBrokerIntentPurchaseStatus =
  | 'idle'
  | 'farming'
  | 'returning'
  | 'purchased'
  | 'abandoned';

export interface SpellBrokerIntent {
  readonly enabled: boolean;
  readonly decisionMade: boolean;
  readonly shouldBuy: boolean;
  readonly spellId: string | null;
  readonly cost: number;
  /** Runtime status of the optional post-spellbook broker purchase. */
  readonly purchaseStatus: SpellBrokerIntentPurchaseStatus;
}

const intents = new WeakMap<GameWorld, SpellBrokerIntent>();

function initialIntent(enabled: boolean): SpellBrokerIntent {
  return {
    enabled,
    decisionMade: false,
    shouldBuy: false,
    spellId: null,
    cost: 0,
    purchaseStatus: 'idle',
  };
}

export function configureSpellBrokerPurchase(world: GameWorld, enabled: boolean): void {
  const current = intents.get(world);
  intents.set(world, current ? { ...current, enabled } : initialIntent(enabled));
}

export function getSpellBrokerIntent(world: GameWorld): SpellBrokerIntent {
  return intents.get(world) ?? initialIntent(false);
}

export function isSpellBrokerPurchaseActive(intent: SpellBrokerIntent): boolean {
  return (
    intent.enabled &&
    intent.shouldBuy &&
    (intent.purchaseStatus === 'idle' ||
      intent.purchaseStatus === 'farming' ||
      intent.purchaseStatus === 'returning')
  );
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

/**
 * Mark the broker purchase as completed (called from auto-progression after
 * {@link purchaseSpellBrokerSpell} returns true). Transitions `purchaseStatus`
 * to `'purchased'` so the goal-graph and snapshot builder stop emitting the
 * optional bundle.
 */
export function markSpellBrokerPurchased(world: GameWorld): void {
  const current = getSpellBrokerIntent(world);
  if (current.purchaseStatus === 'purchased') return;
  intents.set(world, { ...current, purchaseStatus: 'purchased' });
}

/**
 * Drive the post-spellbook optional broker-purchase lifecycle.
 *
 * Called once per AI poll after the behavior tree ticks — identical in timing
 * to {@link updateMerchantWeaponIntent}. Transitions `purchaseStatus` based on
 * whether spells are unlocked, whether the player has enough gold, and whether
 * the run-planner kept or dropped the `spell-broker-purchase` optional bundle.
 */
export function updateSpellBrokerIntent(
  world: GameWorld,
  runPlan: Floor1RunPlan | null,
  goldFarmMs: number,
): SpellBrokerIntent {
  let intent = getSpellBrokerIntent(world);

  // Nothing to do when disabled, already terminal, or decision says no-buy.
  if (
    !intent.enabled ||
    !intent.shouldBuy ||
    intent.purchaseStatus === 'purchased' ||
    intent.purchaseStatus === 'abandoned'
  ) {
    return intent;
  }

  // Activate only once the spells feature is unlocked (post boss-battle).
  if (!world.featureUnlocks.spells) {
    return intent; // stay idle until then
  }

  const deficit = Math.max(0, intent.cost - world.playerGold);

  // Planner explicitly dropped the bundle → abandon.
  if (runPlan?.droppedOptionalBundleIds.includes('spell-broker-purchase')) {
    intent = { ...intent, purchaseStatus: 'abandoned' };
    intents.set(world, intent);
    return intent;
  }

  // Planner explicitly included it → stay farming or switch to returning.
  if (runPlan?.includedOptionalBundleIds.includes('spell-broker-purchase')) {
    const next = deficit > 0 ? 'farming' : 'returning';
    intent = { ...intent, purchaseStatus: next };
    intents.set(world, intent);
    return intent;
  }

  // First activation frame: plan doesn't contain the bundle yet (it will be
  // added next frame once the snapshot carries spellBrokerIntent). Use the
  // required-chain slack to decide feasibility — same bootstrap as
  // updateMerchantWeaponIntent.
  if (intent.purchaseStatus === 'idle') {
    const feasible =
      runPlan !== null && goldFarmMs > 0 && deficit > 0
        ? runPlan.slackMs >= deficit * goldFarmMs
        : true; // gold already sufficient → always feasible
    if (!feasible) {
      intent = { ...intent, purchaseStatus: 'abandoned' };
      intents.set(world, intent);
      return intent;
    }
    const next = deficit > 0 ? 'farming' : 'returning';
    intent = { ...intent, purchaseStatus: next };
    intents.set(world, intent);
    return intent;
  }

  // farming/returning with no explicit planner verdict: keep current status
  // updated for the gold delta only.
  const next = deficit > 0 ? 'farming' : 'returning';
  intent = { ...intent, purchaseStatus: next };
  intents.set(world, intent);
  return intent;
}
