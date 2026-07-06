/**
 * Engage Orbit Loop Debug Lab
 *
 * Replicates seed 3 where fused pathing causes excessive stalling in
 * engagement orbit rather than committing to attacks (timeout on sweep).
 * Frame 2500: player orbits just out of range from enemies.
 */

import { query, hasComponent, entityExists } from 'bitecs';
import { Player, Position, Enemy, Health, type GameWorld } from '../../../core/index.js';
import { createTestWorld } from '../../../tests/helpers/world-factory.js';
import { BehaviorTreeAI } from '../../game/ai/bt-ai-provider.js';
import { createInputState } from '../../../shared/input.js';
import { AIPathingMode, AIState } from '../../game/ai/types.js';
import { SeededRandom } from '../../../shared/random.js';

export interface EngageOrbitDebugState {
  frameCount: number;
  isPaused: boolean;
  world: GameWorld;
  ai: BehaviorTreeAI;
  lastEngageTarget: number | null;
  engageOrbitFrames: number;
}

let state: EngageOrbitDebugState | null = null;

export function setupEngageOrbitDebugLab(): EngageOrbitDebugState {
  // Seed 3: known to have orbit stalling at frame ~2500
  const rng = new SeededRandom(3);
  const world = createTestWorld({ seed: 3, floor: 'floor1', rng });

  const ai = new BehaviorTreeAI(world, {
    pathingMode: AIPathingMode.RISK_REWARD_FUSED,
  });

  state = {
    frameCount: 0,
    isPaused: false,
    world,
    ai,
    lastEngageTarget: null,
    engageOrbitFrames: 0,
  };

  return state;
}

export function stepEngageOrbitDebug(): void {
  if (!state || state.frameCount >= 3000) return;
  if (state.isPaused) return;

  const input = createInputState();
  const decision = state.ai.poll(input, state.frameCount);

  // Track engagement orbit stalling
  if (decision.state === AIState.ENGAGE && decision.targetEid !== null) {
    if (decision.targetEid === state.lastEngageTarget) {
      state.engageOrbitFrames++;
    } else {
      state.lastEngageTarget = decision.targetEid;
      state.engageOrbitFrames = 0;
    }

    // Log when orbit stalling is detected
    if (state.engageOrbitFrames === 30) {
      const targetPos = state.world.Position[decision.targetEid];
      const playerEid = query(state.world, [Player])[0];
      const playerPos = playerEid ? state.world.Position[playerEid] : null;

      console.warn(
        `🔁 ORBIT STALL at frame ${state.frameCount}: ` +
          `engaging same target for 30+ frames. ` +
          `Player @ (${playerPos?.x.toFixed(1)}, ${playerPos?.y.toFixed(1)}) ` +
          `Target @ (${targetPos?.x.toFixed(1)}, ${targetPos?.y.toFixed(1)})`,
      );
    }
  }

  state.frameCount++;
}

export function getEngageOrbitDebugInfo() {
  if (!state) return null;

  const playerEid = query(state.world, [Player])[0];
  const playerPos = playerEid ? state.world.Position[playerEid] : null;

  const enemies = query(state.world, [Enemy, Position, Health]);
  let nearestDist = Infinity;
  let nearestEnemy = null;

  for (const eid of enemies) {
    const pos = state.world.Position[eid];
    if (!pos || !playerPos) continue;
    const dist = Math.hypot(pos.x - playerPos.x, pos.y - playerPos.y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestEnemy = eid;
    }
  }

  return {
    frame: state.frameCount,
    isPaused: state.isPaused,
    playerPos,
    nearestEnemyDist: nearestDist,
    engageTarget: state.lastEngageTarget,
    orbitFrames: state.engageOrbitFrames,
    totalEnemies: enemies.length,
    decisionState: state.ai.poll(createInputState(), state.frameCount).state,
  };
}

export function togglePause() {
  if (state) state.isPaused = !state.isPaused;
}

export function jumpToFrame(frame: number) {
  if (!state) return;
  state.frameCount = Math.min(frame, 3000);
  state.engageOrbitFrames = 0;
  state.lastEngageTarget = null;
}

export function reset() {
  if (!state) return;
  state.frameCount = 0;
  state.isPaused = false;
  state.engageOrbitFrames = 0;
  state.lastEngageTarget = null;
}
