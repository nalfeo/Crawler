/**
 * Floor 4 · Green Room shop stock lifecycle (slice A).
 *
 * Owns the *data and state* of the intermission shops, and nothing else: this
 * module rolls, holds, and retires each visit's immutable stock when the arena
 * director enters/exits each intermission. Purchase transactions, entity
 * placement, sponsor branding, and any UI are explicitly later slices
 * (spec §7.3 / ADR 0090 D7) and are NOT touched here.
 *
 * Design contract enforced here (spec §7):
 *
 * - **Fixed table identities, manifest-authorized pools & per-visit pricing.**
 *   The sponsor tables come from `floor4.greenRoom.tables`; their price curve
 *   from `floor4.greenRoom.priceTierByVisit`. The director hardcodes none of it.
 * - **Path-independent stock.** Each table rolls from its own derived stream
 *   `<seed>:floor4:stock:<visitIndex>:<tableId>`, never from `world.rng`, so
 *   visit N is identical for a seed regardless of how the acts before it went
 *   (ADR 0090 D5).
 * - **Immutable within a visit.** Opening the same visit twice returns the
 *   identical rolled stock; a visit can only advance by exactly one and can
 *   never be reopened once retired.
 * - **Retirement is orphan-free.** Because stock is rolled with the pure,
 *   catalog-based `generateShopInventory`, no generated-equipment registry
 *   instance is ever created for an offer, so retiring a visit cannot leave an
 *   orphan behind — it simply drops the offer data (spec §7.2).
 *
 * Floor/run-scoped: state lives on `world.floorExtendedState.floor4GreenRoom`,
 * created lazily on the first director-entered intermission.
 *
 * Layer-safe: game → core (`generateShopInventory`) → shared. No engine, no UI,
 * no `Math.random()`.
 */
import type { GameWorld } from '../core/world.js';
import { generateShopInventory } from '../core/generateShopInventory.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { getShopArchetype } from '../shared/data/shop-archetypes.js';
import type {
  Floor4GreenRoomOffer,
  Floor4GreenRoomState,
  Floor4GreenRoomTableStock,
  Floor4GreenRoomVisitStock,
} from '../shared/floor-types.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';

/** Purpose label for the derived per-visit, per-table stock streams (ADR D5). */
const FLOOR4_STOCK_STREAM_LABEL = 'floor4:stock';

/**
 * Build the exact derived-stream key for one table's stock on one visit.
 * Format is a data contract asserted by tests — do not reshape casually.
 */
function floor4StockStreamKey(seed: number, visitIndex: number, tableId: string): string {
  return `${seed}:${FLOOR4_STOCK_STREAM_LABEL}:${visitIndex}:${tableId}`;
}

interface Floor4GreenRoomConfig {
  readonly tables: readonly { readonly id: string; readonly archetypeId: string }[];
  readonly priceTierByVisit: readonly number[];
  readonly affordabilityBudgetByVisit: readonly number[];
  readonly actCount: number;
}

function getFloor4GreenRoomConfig(): Floor4GreenRoomConfig {
  const manifest = getFloorManifest('floor4');
  const floor4 = manifest?.floor4;
  if (!floor4) {
    throw new Error('Missing floor4 manifest greenRoom config');
  }
  return {
    tables: floor4.greenRoom.tables,
    priceTierByVisit: floor4.greenRoom.priceTierByVisit,
    affordabilityBudgetByVisit: floor4.greenRoom.affordabilityBudgetByVisit,
    actCount: floor4.phase.actCount,
  };
}

function assertVisitIndex(visitIndex: number, actCount: number): void {
  if (!Number.isInteger(visitIndex) || visitIndex < 0 || visitIndex >= actCount) {
    throw new Error(
      `Floor 4 Green Room visitIndex must be an integer in [0, ${actCount - 1}]; got ${visitIndex}`,
    );
  }
}

/**
 * The worst-case gold-on-hand the balance budget guarantees at `visitIndex`.
 * Schema validation ties this value to the Headliner appearance fee the runtime
 * actually grants, so every visit's rolled stock must contain at least one offer
 * at or below this (spec §8).
 */
function floor4GreenRoomAffordabilityBudget(visitIndex: number): number {
  const config = getFloor4GreenRoomConfig();
  assertVisitIndex(visitIndex, config.actCount);
  return config.affordabilityBudgetByVisit[visitIndex]!;
}

/**
 * Purely roll one visit's stock. Reads the manifest + archetype pools and the
 * floor seed; performs NO world mutation. Identical `seed` + `visitIndex`
 * always produce identical stock (deterministic, path-independent).
 */
function rollFloor4GreenRoomVisit(world: GameWorld, visitIndex: number): Floor4GreenRoomVisitStock {
  const config = getFloor4GreenRoomConfig();
  assertVisitIndex(visitIndex, config.actCount);
  const tierMultiplier = config.priceTierByVisit[visitIndex]!;

  const tables: Floor4GreenRoomTableStock[] = config.tables.map((table) => {
    const archetype = getShopArchetype(table.archetypeId);
    if (!archetype) {
      throw new Error(
        `Floor 4 Green Room table "${table.id}" references unknown shop archetype "${table.archetypeId}"`,
      );
    }
    const streamKey = floor4StockStreamKey(world.seed, visitIndex, table.id);
    const rng = new SeededRandom(hashStringToSeed(streamKey));
    const inventory = generateShopInventory(rng, archetype, { tierMultiplier });
    const offers: readonly Floor4GreenRoomOffer[] = Object.freeze(
      inventory.items.map((item) =>
        Object.freeze({
          itemId: item.itemId,
          unitPrice: item.unitPrice,
          stock: item.stock,
        }),
      ),
    );
    return Object.freeze({
      tableId: table.id,
      archetypeId: table.archetypeId,
      streamKey,
      offers,
    });
  });

  const visit = Object.freeze({ visitIndex, tables: Object.freeze(tables) });
  const cheapest = floor4GreenRoomCheapestOfferPrice(visit);
  const budget = floor4GreenRoomAffordabilityBudget(visitIndex);
  if (cheapest > budget) {
    throw new Error(
      `Floor 4 Green Room visit ${visitIndex} cheapest offer ${cheapest} exceeds guaranteed appearance-fee budget ${budget}`,
    );
  }
  return visit;
}

/** The lowest offer price across every table of a visit (its "buy floor"). */
function floor4GreenRoomCheapestOfferPrice(visit: Floor4GreenRoomVisitStock): number {
  let cheapest = Number.POSITIVE_INFINITY;
  for (const table of visit.tables) {
    for (const offer of table.offers) {
      if (offer.unitPrice < cheapest) cheapest = offer.unitPrice;
    }
  }
  return cheapest;
}

function createFloor4GreenRoomState(): Floor4GreenRoomState {
  return { retiredVisitCount: 0, lastOpenedVisitIndex: -1 };
}

function ensureFloor4GreenRoomState(world: GameWorld): Floor4GreenRoomState {
  const existing = world.floorExtendedState?.floor4GreenRoom;
  if (existing) return existing;
  const state = createFloor4GreenRoomState();
  world.floorExtendedState = { ...world.floorExtendedState, floor4GreenRoom: state };
  return state;
}

type Floor4GreenRoomOpenResult =
  | { readonly ok: true; readonly changed: boolean; readonly visit: Floor4GreenRoomVisitStock }
  | {
      readonly ok: false;
      readonly reason: 'visit-already-open' | 'non-monotonic';
      readonly message: string;
    };

/**
 * Open (roll) the Green Room stock for `visitIndex`.
 *
 * - Re-opening the currently open visit is idempotent and returns the identical
 *   immutable stock (`changed: false`) — never a re-roll.
 * - Opening while a *different* visit is still open fails: the intermission
 *   transaction requires the previous visit to be retired first (ADR D7).
 * - Visits must advance by exactly one; skipping or reopening a retired visit
 *   fails, so unsold stock can never be revisited ("I'll buy it next break" is
 *   never valid — spec §7.2).
 */
export function openFloor4GreenRoomVisit(
  world: GameWorld,
  visitIndex: number,
): Floor4GreenRoomOpenResult {
  const config = getFloor4GreenRoomConfig();
  assertVisitIndex(visitIndex, config.actCount);
  const state = ensureFloor4GreenRoomState(world);

  if (state.currentVisit) {
    if (state.currentVisit.visitIndex === visitIndex) {
      return { ok: true, changed: false, visit: state.currentVisit };
    }
    return {
      ok: false,
      reason: 'visit-already-open',
      message: `Green Room visit ${state.currentVisit.visitIndex} is still open; retire it before opening ${visitIndex}`,
    };
  }

  if (visitIndex !== state.lastOpenedVisitIndex + 1) {
    return {
      ok: false,
      reason: 'non-monotonic',
      message: `Green Room visits must advance from ${state.lastOpenedVisitIndex} to ${state.lastOpenedVisitIndex + 1}; got ${visitIndex}`,
    };
  }

  const visit = rollFloor4GreenRoomVisit(world, visitIndex);
  state.currentVisit = visit;
  state.lastOpenedVisitIndex = visitIndex;
  return { ok: true, changed: true, visit };
}

interface Floor4GreenRoomRetireResult {
  readonly changed: boolean;
  /**
   * Generated-equipment instances eliminated by this retirement. Always 0 in
   * slice A: catalog-based stock creates no registry instances, so retirement
   * is orphan-free by construction (spec §7.2). Retained as an explicit,
   * asserted contract so a future generated-equipment table cannot silently
   * start leaking orphans.
   */
  readonly retiredGeneratedInstances: number;
}

/**
 * Retire the open visit's whole offer (spec §7.2: unsold stock does not carry
 * over). Clears the immutable stock and advances the retired counter. No-op if
 * no visit is open. Orphan-free: no generated-equipment registry entry exists
 * for catalog offers, so nothing is left dangling.
 */
export function retireFloor4GreenRoomVisit(world: GameWorld): Floor4GreenRoomRetireResult {
  const state = world.floorExtendedState?.floor4GreenRoom;
  if (!state || !state.currentVisit) {
    return { changed: false, retiredGeneratedInstances: 0 };
  }
  state.currentVisit = undefined;
  state.retiredVisitCount += 1;
  return { changed: true, retiredGeneratedInstances: 0 };
}
