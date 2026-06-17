/**
 * Rule-based AI input provider.
 *
 * Simulates human input by reading GameWorld state and making decisions.
 * Uses only the InputState interface - no special programmatic access.
 */
import { query, hasComponent } from 'bitecs';
import { Player, Position, Health, Enemy, XpGem, Npc, type GameWorld } from '../../core/index.js';
import type { InputState } from '../../shared/input.js';
import { findTilePath, PATH_TRAVERSAL, type TilePoint } from '../../core/map/pathfinding.js';
import { normalizeInputDirection } from '../../shared/input.js';
import { SeededRandom } from '../../shared/random.js';
import { createLogger } from '../../shared/logger.js';
import { AIState, type AIInputProvider, type AIDecision, type AIConfig } from './types.js';

const logger = createLogger('game:ai-input-provider');

const DEFAULT_CONFIG: Required<AIConfig> = {
  seed: 12345,
  aggression: 1,
  retreatThreshold: 0.3,
  scanRadius: 400,
  rangedSafeDistance: 120,
  debug: false,
};

const TILE_SIZE = 16;

/**
 * Convert world pixel coordinates to tile coordinates.
 */
function worldToTile(x: number, y: number): TilePoint {
  return {
    x: Math.floor(x / TILE_SIZE),
    y: Math.floor(y / TILE_SIZE),
  };
}

/**
 * Convert tile coordinates to world pixel coordinates (center of tile).
 */
function tileToWorld(tile: TilePoint): { x: number; y: number } {
  return {
    x: tile.x * TILE_SIZE + TILE_SIZE / 2,
    y: tile.y * TILE_SIZE + TILE_SIZE / 2,
  };
}

/**
 * Rule-based AI that simulates human input.
 */
export class RuleBasedAI implements AIInputProvider {
  private readonly config: Required<AIConfig>;
  private readonly rng: SeededRandom;
  private decision: AIDecision;
  private pathWaypoints: TilePoint[] = [];
  private pathIndex: number = 0;
  private stuckFrames: number = 0;
  private lastPlayerX: number = 0;
  private lastPlayerY: number = 0;

  constructor(config: AIConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = new SeededRandom(this.config.seed);
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Initializing',
    };
  }

  poll(state: InputState, world: GameWorld): void {
    // Find player entity
    const playerEntities = query(world.ecs, [Player, Position, Health]);
    if (playerEntities.length === 0) {
      // No player - neutral input
      state.moveX = 0;
      state.moveY = 0;
      state.action = false;
      return;
    }

    const playerEid = playerEntities[0];
    if (playerEid === undefined) {
      state.moveX = 0;
      state.moveY = 0;
      state.action = false;
      return;
    }

    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;
    const playerHealth = world.stores.health.current[playerEid] ?? 1;
    const playerMaxHealth = world.stores.health.max[playerEid] ?? 1;
    const healthPercent = playerHealth / playerMaxHealth;

    // Update stuck detection
    const dist = Math.hypot(playerX - this.lastPlayerX, playerY - this.lastPlayerY);
    if (dist < 1) {
      this.stuckFrames++;
    } else {
      this.stuckFrames = 0;
    }
    this.lastPlayerX = playerX;
    this.lastPlayerY = playerY;

    // If stuck for too long, clear path and pick new goal
    if (this.stuckFrames > 60) {
      this.pathWaypoints = [];
      this.stuckFrames = 0;
      if (this.config.debug) {
        logger.debug('AI stuck, clearing path');
      }
    }

    // Decide what to do based on current state
    this.updateDecision(world, playerEid, playerX, playerY, healthPercent);

    // Execute decision: move toward target
    if (this.decision.targetX !== null && this.decision.targetY !== null) {
      this.moveToward(state, world, playerX, playerY, this.decision.targetX, this.decision.targetY);
    } else {
      state.moveX = 0;
      state.moveY = 0;
    }

    // Always attack when there are nearby enemies and we're in engage mode
    if (this.decision.state === AIState.ENGAGE && this.decision.targetEid !== null) {
      state.action = true;
      // Aim at the target enemy
      if (this.decision.targetX !== null && this.decision.targetY !== null) {
        state.pointerX = this.decision.targetX;
        state.pointerY = this.decision.targetY;
      }
    } else {
      state.action = false;
      state.pointerX = playerX;
      state.pointerY = playerY;
    }
  }

  private updateDecision(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    healthPercent: number,
  ): void {
    // State: RETREAT if low health
    if (healthPercent < this.config.retreatThreshold) {
      this.decision.state = AIState.RETREAT;
      this.decision.reason = `Low health (${(healthPercent * 100).toFixed(0)}%)`;
      // TODO: Find nearest safe room
      this.decision.targetX = playerX;
      this.decision.targetY = playerY;
      this.decision.targetEid = null;
      return;
    }

    // Find nearest enemy within scan radius
    const nearestEnemy = this.findNearestEnemy(world, playerX, playerY);

    if (nearestEnemy) {
      // State: ENGAGE - attack the nearest enemy
      this.decision.state = AIState.ENGAGE;
      this.decision.targetEid = nearestEnemy.eid;
      this.decision.targetX = nearestEnemy.x;
      this.decision.targetY = nearestEnemy.y;
      this.decision.reason = `Engaging enemy at distance ${nearestEnemy.distance.toFixed(0)}px`;
      return;
    }

    // Find nearest XP gem within scan radius
    const nearestGem = this.findNearestXpGem(world, playerX, playerY);

    if (nearestGem && nearestGem.distance < this.config.scanRadius / 2) {
      // State: COLLECT - go get that XP
      this.decision.state = AIState.COLLECT;
      this.decision.targetEid = nearestGem.eid;
      this.decision.targetX = nearestGem.x;
      this.decision.targetY = nearestGem.y;
      this.decision.reason = `Collecting XP gem at distance ${nearestGem.distance.toFixed(0)}px`;
      return;
    }

    // Find nearest NPC within scan radius
    const nearestNpc = this.findNearestNpc(world, playerX, playerY);

    if (nearestNpc && nearestNpc.distance < 100) {
      // State: INTERACT - talk to NPC
      this.decision.state = AIState.INTERACT;
      this.decision.targetEid = nearestNpc.eid;
      this.decision.targetX = nearestNpc.x;
      this.decision.targetY = nearestNpc.y;
      this.decision.reason = `Approaching NPC at distance ${nearestNpc.distance.toFixed(0)}px`;
      return;
    }

    // Default: EXPLORE - wander around
    this.decision.state = AIState.EXPLORE;
    this.decision.targetEid = null;
    this.decision.reason = 'Exploring map';

    // Pick a random exploration target if we don't have one
    if (this.decision.targetX === null || this.decision.targetY === null) {
      const angle = this.rng.float() * Math.PI * 2;
      const distance = 200 + this.rng.float() * 200;
      this.decision.targetX = playerX + Math.cos(angle) * distance;
      this.decision.targetY = playerY + Math.sin(angle) * distance;
    }

    // If we're close to exploration target, pick a new one
    if (this.decision.targetX !== null && this.decision.targetY !== null) {
      const dist = Math.hypot(playerX - this.decision.targetX, playerY - this.decision.targetY);
      if (dist < 50) {
        const angle = this.rng.float() * Math.PI * 2;
        const distance = 200 + this.rng.float() * 200;
        this.decision.targetX = playerX + Math.cos(angle) * distance;
        this.decision.targetY = playerY + Math.sin(angle) * distance;
      }
    }
  }

  private moveToward(
    state: InputState,
    world: GameWorld,
    playerX: number,
    playerY: number,
    targetX: number,
    targetY: number,
  ): void {
    const deltaX = targetX - playerX;
    const deltaY = targetY - playerY;
    const distance = Math.hypot(deltaX, deltaY);

    if (distance < 10) {
      // Close enough - stop moving
      state.moveX = 0;
      state.moveY = 0;
      return;
    }

    // Try pathfinding if we have a map
    if (world.floorMap && this.pathWaypoints.length === 0) {
      const startTile = worldToTile(playerX, playerY);
      const goalTile = worldToTile(targetX, targetY);

      const path = findTilePath(world.floorMap, startTile, goalTile, {
        traversalMode: PATH_TRAVERSAL.GROUND,
        maxPathLength: 200,
      });

      if (path.length > 1) {
        this.pathWaypoints = path;
        this.pathIndex = 0;
        if (this.config.debug) {
          logger.debug('AI computed path', { length: path.length });
        }
      }
    }

    // Follow path if we have one
    if (this.pathWaypoints.length > 0 && this.pathIndex < this.pathWaypoints.length) {
      const waypoint = this.pathWaypoints[this.pathIndex];
      if (!waypoint) {
        this.pathWaypoints = [];
        this.pathIndex = 0;
      } else {
        const waypointWorld = tileToWorld(waypoint);
        const waypointDist = Math.hypot(playerX - waypointWorld.x, playerY - waypointWorld.y);

        if (waypointDist < 8) {
          // Reached waypoint - move to next
          this.pathIndex++;
          if (this.pathIndex >= this.pathWaypoints.length) {
            this.pathWaypoints = [];
            this.pathIndex = 0;
          }
        } else {
          // Move toward current waypoint
          const normalized = normalizeInputDirection(
            (waypointWorld.x - playerX) / waypointDist,
            (waypointWorld.y - playerY) / waypointDist,
          );
          state.moveX = normalized.moveX;
          state.moveY = normalized.moveY;
          return;
        }
      }
    }

    // Fallback: direct movement toward target
    const normalized = normalizeInputDirection(deltaX / distance, deltaY / distance);
    state.moveX = normalized.moveX;
    state.moveY = normalized.moveY;
  }

  private findNearestEnemy(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): { eid: number; x: number; y: number; distance: number } | null {
    const enemies = query(world.ecs, [Enemy, Position, Health]);
    let nearest: { eid: number; x: number; y: number; distance: number } | null = null;
    let minDist = this.config.scanRadius;

    for (const eid of enemies) {
      if (eid === undefined) continue;

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const health = world.stores.health.current[eid] ?? 0;

      if (health <= 0) continue;

      const dist = Math.hypot(x - playerX, y - playerY);
      if (dist < minDist) {
        minDist = dist;
        nearest = { eid, x, y, distance: dist };
      }
    }

    return nearest;
  }

  private findNearestXpGem(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): { eid: number; x: number; y: number; distance: number } | null {
    const gems = query(world.ecs, [XpGem, Position]);
    let nearest: { eid: number; x: number; y: number; distance: number } | null = null;
    let minDist = this.config.scanRadius;

    for (const eid of gems) {
      if (eid === undefined) continue;

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dist = Math.hypot(x - playerX, y - playerY);

      if (dist < minDist) {
        minDist = dist;
        nearest = { eid, x, y, distance: dist };
      }
    }

    return nearest;
  }

  private findNearestNpc(
    world: GameWorld,
    playerX: number,
    playerY: number,
  ): { eid: number; x: number; y: number; distance: number } | null {
    const npcs = query(world.ecs, [Npc, Position]);
    let nearest: { eid: number; x: number; y: number; distance: number } | null = null;
    let minDist = this.config.scanRadius;

    for (const eid of npcs) {
      if (eid === undefined) continue;

      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      const dist = Math.hypot(x - playerX, y - playerY);

      if (dist < minDist) {
        minDist = dist;
        nearest = { eid, x, y, distance: dist };
      }
    }

    return nearest;
  }

  getDecision(): AIDecision {
    return { ...this.decision };
  }

  reset(): void {
    this.decision = {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'Reset',
    };
    this.pathWaypoints = [];
    this.pathIndex = 0;
    this.stuckFrames = 0;
  }
}
