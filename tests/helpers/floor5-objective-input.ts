import { query } from 'bitecs';
import { findTilePath } from '../../src/core/map/pathfinding.js';
import { Player, SiegeMinion } from '../../src/core/components.js';
import { applyDamage } from '../../src/core/index.js';
import {
  computeSiegeCastleLayout,
  siegeCastleOptionsFromConfig,
} from '../../src/core/map/generators/SiegeCastleGenerator.js';
import type { GameWorld } from '../../src/core/world.js';
import { AIState, type AIDecision, type AIInputProvider } from '../../src/game/ai/types.js';
import type { InputState } from '../../src/shared/input.js';

/**
 * Deterministic, ordinary-input Floor 5 pilot for headless scenario gates.
 * It walks the authored map, attacks the opening sortie, and explicitly enters
 * INTERACT at recover/build prompts. The runner translates that intent through
 * the same scenario interaction authority used by the E/Tap control.
 */
export class Floor5ObjectiveInputProvider implements AIInputProvider {
  private decision: AIDecision = {
    state: AIState.EXPLORE,
    targetEid: null,
    targetX: null,
    targetY: null,
    reason: 'floor5 objective route',
    npcInteraction: null,
    debug: null,
  };

  poll(input: InputState, world: GameWorld): void {
    input.moveX = 0;
    input.moveY = 0;
    input.action = false;
    const state = world.floorExtendedState?.floor5Siege;
    const player = query(world.ecs, [Player])[0];
    if (!state || player === undefined || !world.floorMap) return;

    let target: { x: number; y: number } | null = null;
    let targetEid: number | null = null;
    let interaction = false;
    if (!state.tasks.openingPushRepelled) {
      const enemy = query(world.ecs, [SiegeMinion]).find(
        (eid) => (world.stores.siegeMinion.team[eid] ?? 0) === 2,
      );
      if (enemy !== undefined) {
        targetEid = enemy;
        target = { x: world.stores.position.x[enemy] ?? 0, y: world.stores.position.y[enemy] ?? 0 };
        input.action = true;
        input.pointerX = target.x;
        input.pointerY = target.y;
      }
    } else {
      const layout = computeSiegeCastleLayout(siegeCastleOptionsFromConfig(world.floorMap.config));
      const tileSize = world.floorMap.config.tileSizeFt;
      const center = (bounds: { x: number; y: number; width: number; height: number }) => ({
        x: (bounds.x + bounds.width / 2) * tileSize + tileSize / 2,
        y: (bounds.y + bounds.height / 2) * tileSize + tileSize / 2,
      });
      if (!state.tasks.yardSecured) target = center(layout.siegeYard);
      else if (state.tasks.recoveredComponents.length < 3) {
        target = center(layout.componentPocket);
        interaction = true;
      } else if (!state.tasks.checkpointCleared) target = center(layout.checkpointPocket);
      else if (state.engineState === 'LOCKED') {
        target = state.ram.route[0] ?? null;
        interaction = true;
      } else if (!state.breach.latched) {
        // Do not body-block the ram after authorizing construction.
        target =
          state.ram.route[Math.min(state.ram.routeIndex + 1, state.ram.route.length - 1)] ?? null;
      } else if (state.breach.latched && !state.finale.courtyardCleared)
        target = center(layout.courtyard);
      else if (state.breach.latched && !state.finale.captured) target = center(layout.throneRoom);
    }
    if (!target) return;

    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    const start = world.floorMap.worldToTile(px, py);
    const goal = world.floorMap.worldToTile(target.x, target.y);
    const path = findTilePath(world.floorMap, start, goal);
    const waypoint = path[Math.min(2, path.length - 1)];
    const resolved = waypoint ? world.floorMap.tileToWorld(waypoint.x, waypoint.y) : target;
    const dx = resolved.x - px;
    const dy = resolved.y - py;
    const distance = Math.hypot(dx, dy);
    if (distance > 0) {
      input.moveX = dx / distance;
      input.moveY = dy / distance;
    }
    const atTarget = Math.hypot(target.x - px, target.y - py) <= 9;
    this.decision = {
      state:
        interaction && atTarget
          ? AIState.INTERACT
          : targetEid === null
            ? AIState.EXPLORE
            : AIState.ENGAGE,
      targetEid,
      targetX: target.x,
      targetY: target.y,
      reason: interaction ? 'floor5 authored interaction' : 'floor5 objective route',
      npcInteraction: null,
      debug: null,
    };
  }

  getDecision(): AIDecision {
    return this.decision;
  }

  reset(): void {}
}

/**
 * Test-only combat probe that closes the opening-push combat gate through the
 * real damage/death event path with the player recorded as the source. Finale
 * tests already use the same kind of probe to keep encounter timing bounded.
 */
export function playerRepelsFloor5OpeningPush(world: GameWorld): void {
  const state = world.floorExtendedState?.floor5Siege;
  if (!state || state.tasks.openingPushRepelled) return;
  const player = query(world.ecs, [Player])[0];
  const enemy = query(world.ecs, [SiegeMinion]).find(
    (eid) => (world.stores.siegeMinion.team[eid] ?? 0) === 2,
  );
  if (player === undefined || enemy === undefined) return;
  applyDamage(
    world,
    enemy,
    (world.stores.health.current[enemy] ?? 0) + 1,
    world.stores.position.x[enemy] ?? 0,
    world.stores.position.y[enemy] ?? 0,
    {
      origin: 'weapon',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      sourceEid: player,
    },
  );
}
