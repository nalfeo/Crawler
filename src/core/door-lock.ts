import { hasComponent, query } from 'bitecs';
import { getItemCount } from '../shared/inventory.js';
import { Inventory, Player } from './components.js';
import type { GameWorld } from './world.js';

export type DoorConditionOperator = 'all' | 'any';

export interface DoorInventoryCondition {
  type: 'inventory';
  itemId: string;
  quantity: number;
  holderEid?: number;
}

export interface DoorGoalCondition {
  type: 'goal';
  goalId: string;
}

export interface DoorTimerCondition {
  type: 'timer';
  elapsedMs: number;
}

export type DoorLockCondition = DoorInventoryCondition | DoorGoalCondition | DoorTimerCondition;

export interface DoorConditionGroup {
  operator: DoorConditionOperator;
  conditions: DoorLockCondition[];
}

export interface DoorLockConfig {
  unlock: DoorConditionGroup;
  relock?: DoorConditionGroup;
}

function assertValidConditionGroup(group: DoorConditionGroup, context: string): void {
  if (group.conditions.length === 0) {
    throw new Error(`${context} condition group must include at least one condition.`);
  }
  if (group.operator !== 'all' && group.operator !== 'any') {
    throw new Error(`${context} condition group operator must be "all" or "any".`);
  }

  for (const condition of group.conditions) {
    switch (condition.type) {
      case 'inventory':
        if (!condition.itemId) {
          throw new Error(`${context} inventory condition requires a non-empty itemId.`);
        }
        if (!Number.isFinite(condition.quantity) || condition.quantity <= 0) {
          throw new Error(`${context} inventory condition quantity must be a positive number.`);
        }
        break;
      case 'goal':
        if (!condition.goalId) {
          throw new Error(`${context} goal condition requires a non-empty goalId.`);
        }
        break;
      case 'timer':
        if (!Number.isFinite(condition.elapsedMs) || condition.elapsedMs < 0) {
          throw new Error(`${context} timer condition elapsedMs must be >= 0.`);
        }
        break;
      default: {
        const unreachable: never = condition;
        throw new Error(`Unsupported door lock condition type: ${String(unreachable)}`);
      }
    }
  }
}

function cloneGroup(group: DoorConditionGroup): DoorConditionGroup {
  return {
    operator: group.operator,
    conditions: group.conditions.map((condition) => ({ ...condition })),
  };
}

function resolveInventoryHolder(
  world: GameWorld,
  condition: DoorInventoryCondition,
): number | undefined {
  if (condition.holderEid !== undefined) {
    if (hasComponent(world.ecs, condition.holderEid, Inventory)) {
      return condition.holderEid;
    }
    return undefined;
  }

  const players = query(world.ecs, [Player, Inventory]);
  return players[0];
}

function evaluateCondition(
  world: GameWorld,
  condition: DoorLockCondition,
  goalOverrides?: ReadonlyMap<string, boolean> | null,
): boolean {
  switch (condition.type) {
    case 'inventory': {
      const holder = resolveInventoryHolder(world, condition);
      if (holder === undefined) {
        return false;
      }
      const bag = world.inventories.get(holder);
      if (!bag) {
        return false;
      }
      return getItemCount(bag, condition.itemId) >= condition.quantity;
    }
    case 'goal': {
      const override = goalOverrides?.get(condition.goalId);
      if (override !== undefined) return override;
      return world.goalFlags.get(condition.goalId) === true;
    }
    case 'timer':
      return world.elapsedMs >= condition.elapsedMs;
    default: {
      const unreachable: never = condition;
      throw new Error(`Unsupported door lock condition type: ${String(unreachable)}`);
    }
  }
}

/**
 * Evaluate a door condition group against live world state, or against a
 * hypothetical override for `'goal'` conditions when `goalOverrides` is
 * supplied. Used by planning code that must ask "would this door be open IF
 * goal X were already satisfied?" without mutating the real world — see
 * `floor1-travel-oracle.ts`. Omitting `goalOverrides` (or passing `null`)
 * preserves the exact live-world behavior every existing caller depends on.
 */
export function evaluateDoorConditionGroup(
  world: GameWorld,
  group: DoorConditionGroup,
  goalOverrides?: ReadonlyMap<string, boolean> | null,
): boolean {
  if (group.operator === 'all') {
    return group.conditions.every((condition) =>
      evaluateCondition(world, condition, goalOverrides),
    );
  }
  return group.conditions.some((condition) => evaluateCondition(world, condition, goalOverrides));
}

export function setDoorLockConfig(world: GameWorld, doorEid: number, config: DoorLockConfig): void {
  assertValidConditionGroup(config.unlock, 'Door unlock');
  if (config.relock) {
    assertValidConditionGroup(config.relock, 'Door relock');
  }

  world.doorLockConfigs.set(doorEid, {
    unlock: cloneGroup(config.unlock),
    relock: config.relock ? cloneGroup(config.relock) : undefined,
  });
}

export function clearDoorLockConfig(world: GameWorld, doorEid: number): void {
  world.doorLockConfigs.delete(doorEid);
}

export function getDoorLockConfig(world: GameWorld, doorEid: number): DoorLockConfig | undefined {
  return world.doorLockConfigs.get(doorEid);
}

export function setGoalFlag(world: GameWorld, goalId: string, complete: boolean): void {
  if (!goalId) {
    throw new Error('Goal flag id must be non-empty.');
  }
  world.goalFlags.set(goalId, complete);
}

export function isGoalFlagComplete(world: GameWorld, goalId: string): boolean {
  return world.goalFlags.get(goalId) === true;
}
