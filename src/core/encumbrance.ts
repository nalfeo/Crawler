/**
 * Core (ECS-aware) encumbrance snapshot — combines an entity's `Weight`
 * component (body mass), its equipped gear weight (deduped, see
 * `effective-stats.ts#computeEquippedWeightLb`), and its effective Strength
 * into the pure band/threshold math in `shared/encumbrance.ts`.
 *
 * Shared by the movement pipeline (`playerInputSystem`, `bt-ai-provider`) and
 * `EquipmentUI` (equipped weight / total mass / band display) so they can
 * never disagree.
 */
import { hasComponent } from 'bitecs';
import { EffectiveStats, Weight } from './components.js';
import type { GameWorld } from './world.js';
import { computeEquippedWeightLb } from './effective-stats.js';
import { getEquipmentState } from './systems/equipmentSystem.js';
import {
  computeEncumbranceThresholds,
  computeEncumbranceBand,
  computeEncumbranceMultiplier,
  type EncumbranceBand,
  type EncumbranceThresholds,
} from '../shared/encumbrance.js';

export interface EntityEncumbranceSnapshot {
  readonly bodyWeightLb: number;
  readonly equippedWeightLb: number;
  readonly totalMassLb: number;
  readonly thresholds: EncumbranceThresholds;
  readonly band: EncumbranceBand;
  /** Move-speed multiplier for the current band (1 = unburdened). */
  readonly moveSpeedMultiplier: number;
}

/** Full encumbrance snapshot for an entity — body + equipped mass, band, and multiplier. */
export function getEntityEncumbranceSnapshot(
  world: GameWorld,
  eid: number,
): EntityEncumbranceSnapshot {
  const bodyWeightLb = hasComponent(world.ecs, eid, Weight)
    ? (world.stores.weight.value[eid] ?? 0)
    : 0;
  const effectiveStrength = hasComponent(world.ecs, eid, EffectiveStats)
    ? (world.stores.effectiveStats.strength[eid] ?? 0)
    : 0;
  const equippedWeightLb = computeEquippedWeightLb(world, getEquipmentState(world, eid));
  const totalMassLb = bodyWeightLb + equippedWeightLb;
  const thresholds = computeEncumbranceThresholds(bodyWeightLb, effectiveStrength);
  const band = computeEncumbranceBand(totalMassLb, thresholds);
  return {
    bodyWeightLb,
    equippedWeightLb,
    totalMassLb,
    thresholds,
    band,
    moveSpeedMultiplier: computeEncumbranceMultiplier(band),
  };
}

/** Just the move-speed multiplier — convenience for movement read-sites. */
export function getEntityEncumbranceMultiplier(world: GameWorld, eid: number): number {
  return getEntityEncumbranceSnapshot(world, eid).moveSpeedMultiplier;
}
