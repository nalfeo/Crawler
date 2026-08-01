import { query } from 'bitecs';
import { Player, Position, XpGem, type GameWorld } from '../../../src/core/index.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import type { AIInputProvider } from '../../../src/game/ai/types.js';
import { analyzeXpSpatialDistribution } from '../../../src/game/ai/xp-collection-analysis.js';
import type { InputState } from '../../../src/shared/input.js';

const RESULT_MARKER = 'XP_PROBE_RESULT=';

function parseNumberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed)) throw new Error(`${name} requires a finite number`);
  return parsed;
}

function parseStringFlag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function resolveExit(world: GameWorld): { x: number; y: number } | null {
  if (world.floorId === 'floor2') {
    const state = world.floorExtendedState?.familyState;
    return state?.staircaseSpawned &&
      state.staircaseUnlocked &&
      !state.staircaseDiscovered &&
      state.staircasePos
      ? state.staircasePos
      : null;
  }
  const objective = world.floorScenario?.objective;
  return objective?.staircaseUnlocked && !objective.staircaseDiscovered
    ? objective.staircasePos
    : null;
}

class ExitSnapshotProvider implements AIInputProvider {
  routeStart: { x: number; y: number } | null = null;
  exit: { x: number; y: number } | null = null;

  constructor(private readonly delegate: BehaviorTreeAI) {}

  poll(state: InputState, world: GameWorld): void {
    if (!this.exit) {
      const exit = resolveExit(world);
      const player = query(world.ecs, [Player, Position])[0];
      if (exit && player !== undefined) {
        this.exit = { ...exit };
        this.routeStart = {
          x: world.stores.position.x[player] ?? 0,
          y: world.stores.position.y[player] ?? 0,
        };
      }
    }
    this.delegate.poll(state, world);
  }

  getDecision(): ReturnType<BehaviorTreeAI['getDecision']> {
    return this.delegate.getDecision();
  }

  reset(): void {
    this.routeStart = null;
    this.exit = null;
    this.delegate.reset();
  }
}

const seed = parseNumberFlag('--seed', 1);
const maxFrames = parseNumberFlag('--max-frames', 100_000);
const maxWallTimeMs = parseNumberFlag('--max-time-ms', 300_000);
const floorId = parseStringFlag('--floor', 'floor2');
const budgets = parseStringFlag('--budgets', '25,50,100,200')
  .split(',')
  .map(Number)
  .filter(Number.isFinite);
const provider = new ExitSnapshotProvider(new BehaviorTreeAI({ seed }));
let spatial:
  | ReturnType<typeof analyzeXpSpatialDistribution>
  | { unavailable: true; reason: string }
  | undefined;

const stats = await runHeadless(provider, {
  seed,
  floorId,
  maxFrames,
  maxWallTimeMs,
  recordXpCollection: true,
  onFinish: (world) => {
    if (!provider.routeStart || !provider.exit) {
      spatial = { unavailable: true, reason: 'exit route never became available' };
      return;
    }
    const gems = Array.from(query(world.ecs, [XpGem, Position]), (eid) => ({
      eid,
      x: world.stores.position.x[eid] ?? 0,
      y: world.stores.position.y[eid] ?? 0,
      value: world.stores.xpGem.value[eid] ?? 0,
    }));
    const floor = statsPlaceholder(world);
    spatial = analyzeXpSpatialDistribution({
      gems,
      routeStart: provider.routeStart,
      exit: provider.exit,
      spawnedXp: floor.spawned,
      collectedXp: floor.collected,
      detourBudgetsFt: budgets,
      attractionRadiusFt: 4,
      clusterRadiusFt: 12,
    });
  },
});

function statsPlaceholder(world: GameWorld): { spawned: number; collected: number } {
  return {
    spawned: world.xpCollectionTelemetry?.current.spawned ?? 0,
    collected: world.xpCollectionTelemetry?.current.collected ?? 0,
  };
}

console.log(
  `${RESULT_MARKER}${JSON.stringify({
    seed,
    floorId,
    maxFrames,
    maxWallTimeMs,
    outcome: stats.outcome,
    gameTimeMs: stats.gameTimeMs,
    wallTimeMs: stats.wallTimeMs,
    finalLevel: stats.finalLevel,
    xpCollection: stats.xpCollection,
    routeStart: provider.routeStart,
    exit: provider.exit,
    spatial,
  })}`,
);
