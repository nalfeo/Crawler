import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  setEnemyAppearanceKey,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../src/core/spawners/combatants.js';
import { pickGeneratedEnemyTextureKey } from '../../src/engine/phaser-bridge/sprite-kind.js';
import { runSimulationStep as runVisualSimulationStep } from '../../src/engine/sim/simulation-step.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless, type HeadlessRunnerConfig } from '../../src/game/ai/headless-runner.js';
import { runSimulationStep as runHeadlessSimulationStep } from '../../src/game/ai/simulation-step.js';
import { loadShippedGeneratedSpriteRegistry } from '../../src/game/ai/shipped-sprite-registry.js';
import {
  buildGeneratedSpriteRegistry,
  computeNormalizedWeaponAnchor,
  getEntityNormalizedWeaponAnchor,
  normalizeGeneratedSpriteConceptId,
  resolveGeneratedSpriteVariantForEntity,
  type GeneratedSpriteRegistry,
  type NormalizedWeaponAnchor,
} from '../../src/shared/generated-assets.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const baseEntry = {
  spriteName: 'welcome-goon-var-0',
  assetPath: 'generated/welcome-goon-var-0.png',
  approvedAt: '2026-09-04T00:00:00.000Z',
  sourceRun: 'generated/runs/welcome-goon/test',
  anchor: { x: 8, y: 8, source: 'brief' as const },
  sensorScore: '7/7',
  judgeScore: '4',
};

const registry = buildGeneratedSpriteRegistry({
  version: 1,
  entries: {
    'npc-welcome-goon-var-8': {
      ...baseEntry,
      briefId: 'npc-welcome-goon',
      spriteName: 'npc-welcome-goon-var-8',
      assetPath: 'generated/npc-welcome-goon-var-8.png',
      variantIndex: 8,
    },
    'welcome-goon-var-1': {
      ...baseEntry,
      briefId: 'welcome-goon',
      spriteName: 'welcome-goon-var-1',
      assetPath: 'generated/welcome-goon-var-1.png',
      variantIndex: 1,
    },
    'welcome-goon-v2-var-2': {
      ...baseEntry,
      briefId: 'welcome-goon-v2',
      spriteName: 'welcome-goon-v2-var-2',
      assetPath: 'generated/welcome-goon-v2-var-2.png',
      variantIndex: 2,
      disliked: true,
    },
  },
});

function spawnVariantSequence(seed: number, runtime: 'visual' | 'headless'): string[] {
  const world = createTestWorld({ seed, generatedSpriteRegistry: registry });
  const playerEid = spawnPlayer(world, -100, -100);
  initializeFloor1Scenario(world, playerEid);
  const choices: string[] = [];
  const spawned: Array<{ eid: number; appearanceKey: string }> = [];

  for (let index = 0; index < 32; index++) {
    const eid = spawnBehaviorEnemy(world, index, 0, 10, 0, 1, 10, 1);
    const appearanceKey =
      index % 3 === 0 ? 'npc-welcome-goon' : index % 3 === 1 ? 'welcome-goon' : 'welcome-goon-v2';
    setEnemyAppearanceKey(world, eid, appearanceKey);
    spawned.push({ eid, appearanceKey });
  }

  if (runtime === 'visual') {
    runVisualSimulationStep(world, createInputState());
  } else {
    runHeadlessSimulationStep(world, createInputState(), GAME.DELTA_MS);
  }

  for (const { eid, appearanceKey } of spawned) {
    const visualChoice = pickGeneratedEnemyTextureKey(
      registry,
      'enemy_rat',
      world.stores.sprite.variantRoll[eid],
      appearanceKey,
    );
    const headlessChoice = resolveGeneratedSpriteVariantForEntity(world, eid)?.textureKey ?? null;

    expect(headlessChoice).toBe(visualChoice);
    expect(visualChoice).not.toBe('welcome-goon-v2-var-2');
    choices.push(visualChoice!);
  }

  return choices;
}

function appearanceStateAfterHeadlessSpawn(seed: number, injectRegistry: boolean) {
  const world = injectRegistry
    ? createTestWorld({ seed, generatedSpriteRegistry: registry })
    : createTestWorld({ seed });
  const playerEid = spawnPlayer(world, -100, -100);
  initializeFloor1Scenario(world, playerEid);
  const spawned: number[] = [];

  for (let index = 0; index < 32; index++) {
    const eid = spawnBehaviorEnemy(world, index, 0, 10, 0, 1, 10, 1);
    const appearanceKey =
      index % 3 === 0 ? 'npc-welcome-goon' : index % 3 === 1 ? 'welcome-goon' : 'welcome-goon-v2';
    setEnemyAppearanceKey(world, eid, appearanceKey);
    spawned.push(eid);
  }

  runHeadlessSimulationStep(world, createInputState(), GAME.DELTA_MS);
  return {
    variantRolls: spawned.map((eid) => world.stores.sprite.variantRoll[eid]),
    gameplayRngTail: Array.from({ length: 8 }, () => world.rng.next()),
  };
}

async function appearanceStateThroughHeadlessRunner(seed: number, injectRegistry: boolean) {
  let observed:
    | {
        readonly textureKey: string | null;
        readonly variantRoll: number;
        readonly gameplayRngTail: readonly number[];
      }
    | undefined;
  await runHeadless(new BehaviorTreeAI({ seed }), {
    seed,
    maxFrames: 1,
    maxWallTimeMs: 30_000,
    enforcePlayabilityInvariants: false,
    generatedSpriteRegistry: injectRegistry ? registry : null,
    simulationOptions: {
      postSystems: [
        (world) => {
          const eid = spawnBehaviorEnemy(world, 0, 0, 10, 0, 1, 10, 1);
          setEnemyAppearanceKey(world, eid, 'welcome-goon-v2');
          const variantRoll = world.stores.sprite.variantRoll[eid];
          if (variantRoll === undefined) {
            throw new Error(`Spawned entity ${eid} has no appearance variant roll.`);
          }
          observed = {
            textureKey: resolveGeneratedSpriteVariantForEntity(world, eid)?.textureKey ?? null,
            variantRoll,
            gameplayRngTail: Array.from({ length: 8 }, () => world.rng.next()),
          };
        },
      ],
    },
  });
  if (observed === undefined)
    throw new Error('Headless runner did not execute the registry probe.');
  return observed;
}

/**
 * Registry with authored `anchors.weapon` values. The shipped shard tree has no
 * weapon anchors today, so proving the render/headless seams agree on ANCHORS
 * (not just texture keys) needs art that actually carries one — otherwise both
 * sides trivially agree on `null` and the check would rot silently the day a
 * muzzle-anchored mob ships.
 */
const anchoredRegistry = buildGeneratedSpriteRegistry({
  version: 1,
  entries: {
    'rat-var-0': {
      ...baseEntry,
      briefId: 'rat',
      spriteName: 'rat-var-0',
      assetPath: 'generated/rat-var-0.png',
      variantIndex: 0,
      facingDirection: 'right' as const,
      anchors: {
        hold: { x: 32, y: 60, source: 'derived' as const },
        centerOfGravity: { x: 32, y: 32, source: 'derived' as const },
        weapon: { x: 48, y: 36, source: 'manual' as const },
      },
    },
    'rat-var-1': {
      ...baseEntry,
      briefId: 'rat',
      spriteName: 'rat-var-1',
      assetPath: 'generated/rat-var-1.png',
      variantIndex: 1,
      facingDirection: 'left' as const,
      anchors: {
        hold: { x: 30, y: 58, source: 'derived' as const },
        centerOfGravity: { x: 30, y: 30, source: 'derived' as const },
        weapon: { x: 12, y: 41, source: 'manual' as const },
      },
    },
    'rat-var-2': {
      ...baseEntry,
      briefId: 'rat',
      spriteName: 'rat-var-2',
      assetPath: 'generated/rat-var-2.png',
      variantIndex: 2,
      facingDirection: 'right' as const,
      anchors: {
        hold: { x: 33, y: 61, source: 'derived' as const },
        centerOfGravity: { x: 33, y: 29, source: 'derived' as const },
        weapon: { x: 51, y: 20, source: 'manual' as const },
      },
    },
  },
});

interface HeadlessRegistryProbe {
  readonly registryPresent: boolean;
  readonly registryIsShipped: boolean;
  readonly variantRoll: number;
  readonly headlessTextureKey: string | null;
  readonly rendererTextureKey: string | null;
  readonly headlessAnchor: NormalizedWeaponAnchor | null;
  readonly rendererAnchor: NormalizedWeaponAnchor | null;
  readonly gameplayRngTail: readonly number[];
}

/**
 * Drive one frame of `runHeadless`, spawn a `rat`, and capture what BOTH seams
 * resolve for it: the renderer's `pickGeneratedEnemyTextureKey` (what the player
 * sees) and the simulation's `resolveGeneratedSpriteVariantForEntity` /
 * `getEntityNormalizedWeaponAnchor` (what a sweep simulates).
 *
 * `'omitted'` leaves `generatedSpriteRegistry` off the config entirely — the
 * standard sweep/headless call shape — so the default-registry contract is
 * exercised through the real public entry point, not a hand-built world.
 */
async function probeHeadlessRegistry(
  seed: number,
  registryOverride: 'omitted' | { readonly registry: GeneratedSpriteRegistry | null },
): Promise<HeadlessRegistryProbe> {
  const shipped = await loadShippedGeneratedSpriteRegistry();
  let observed: HeadlessRegistryProbe | undefined;
  const baseConfig: HeadlessRunnerConfig = {
    seed,
    maxFrames: 1,
    maxWallTimeMs: 30_000,
    enforcePlayabilityInvariants: false,
    simulationOptions: {
      postSystems: [
        (world) => {
          const eid = spawnBehaviorEnemy(world, 0, 0, 10, 0, 1, 10, 1);
          setEnemyAppearanceKey(world, eid, 'rat');
          const variantRoll = world.stores.sprite.variantRoll[eid];
          if (variantRoll === undefined) {
            throw new Error(`Spawned entity ${eid} has no appearance variant roll.`);
          }
          const registry = world.generatedSpriteRegistry;
          const rendererTextureKey = pickGeneratedEnemyTextureKey(
            registry,
            'enemy_rat',
            variantRoll,
            'rat',
          );
          const rendererEntry =
            registry?.entries().find((entry) => entry.textureKey === rendererTextureKey) ?? null;
          observed = {
            registryPresent: registry !== null,
            registryIsShipped: registry === shipped,
            variantRoll,
            headlessTextureKey:
              resolveGeneratedSpriteVariantForEntity(world, eid)?.textureKey ?? null,
            rendererTextureKey,
            headlessAnchor: getEntityNormalizedWeaponAnchor(world, eid),
            rendererAnchor: computeNormalizedWeaponAnchor(rendererEntry),
            gameplayRngTail: Array.from({ length: 8 }, () => world.rng.next()),
          };
        },
      ],
    },
  };
  const config: HeadlessRunnerConfig =
    registryOverride === 'omitted'
      ? baseConfig
      : { ...baseConfig, generatedSpriteRegistry: registryOverride.registry };
  await runHeadless(new BehaviorTreeAI({ seed }), config);
  if (observed === undefined) {
    throw new Error('Headless runner did not execute the registry probe.');
  }
  return observed;
}

describe('seeded sprite variant runtime contract', () => {
  it('normalizes historical role and lineage IDs to one concept', () => {
    expect(
      ['npc-welcome-goon', 'welcome-goon', 'welcome-goon-v2'].map(
        normalizeGeneratedSpriteConceptId,
      ),
    ).toEqual(['welcome-goon', 'welcome-goon', 'welcome-goon']);
    expect(normalizeGeneratedSpriteConceptId('angry-roomba-v2-var-1')).toBe('angry-roomba-mk2');
    expect(registry.briefIds()).toEqual(['welcome-goon']);
  });

  it('replays choices across visual and headless seams while excluding disliked variants', () => {
    const first = spawnVariantSequence(42, 'visual');
    const replay = spawnVariantSequence(42, 'visual');
    const headless = spawnVariantSequence(42, 'headless');

    expect(replay).toEqual(first);
    expect(headless).toEqual(first);
    expect(new Set(first)).toEqual(new Set(['npc-welcome-goon-var-8', 'welcome-goon-var-1']));
  });

  it('leaves gameplay RNG state identical with and without a generated sprite registry', () => {
    const defaultHeadless = appearanceStateAfterHeadlessSpawn(42, false);
    const registryInjected = appearanceStateAfterHeadlessSpawn(42, true);

    expect(registryInjected.gameplayRngTail).toEqual(defaultHeadless.gameplayRngTail);
    expect(registryInjected.variantRolls).toEqual(defaultHeadless.variantRolls);
  });

  it('uses the injected registry through runHeadless without drifting gameplay RNG', async () => {
    const first = await appearanceStateThroughHeadlessRunner(42, true);
    const replay = await appearanceStateThroughHeadlessRunner(42, true);
    const withoutRegistry = await appearanceStateThroughHeadlessRunner(42, false);

    expect(first).toEqual(replay);
    expect(first.textureKey).toMatch(/^(npc-)?welcome-goon-var-(1|8)$/);
    expect(first.textureKey).not.toBe('welcome-goon-v2-var-2');
    expect(withoutRegistry.textureKey).toBeNull();
    expect(first.variantRoll).toBe(withoutRegistry.variantRoll);
    expect(first.gameplayRngTail).toEqual(withoutRegistry.gameplayRngTail);
  });

  it('loads the shipped generated-sprite registry once and never empty', async () => {
    const first = await loadShippedGeneratedSpriteRegistry();
    const second = await loadShippedGeneratedSpriteRegistry();

    expect(first).not.toBeNull();
    // Cached: sweeps call runHeadless hundreds of times and must not re-walk
    // the ~500-shard tree per run.
    expect(second).toBe(first);
    expect(first!.size).toBeGreaterThan(0);
    // A concept the committed shard tree is known to ship — proves we loaded
    // real art rather than silently falling back to an empty registry.
    expect(first!.variants('rat').length).toBeGreaterThan(0);
  });

  it('retries a shipped registry load after a transient filesystem failure', () => {
    const missingRoot = mkdtempSync(path.join(tmpdir(), 'missing-shipped-registry-'));
    const moduleUrl = pathToFileURL(
      path.join(REPO_ROOT, 'src', 'game', 'ai', 'shipped-sprite-registry.ts'),
    ).href;
    const probe = `
      import { loadShippedGeneratedSpriteRegistry } from ${JSON.stringify(moduleUrl)};
      (async () => {
        process.chdir(${JSON.stringify(missingRoot)});
        let failed = false;
        try {
          await loadShippedGeneratedSpriteRegistry();
        } catch {
          failed = true;
        }
        if (!failed) throw new Error('expected the missing shard tree to fail');
        process.chdir(${JSON.stringify(REPO_ROOT)});
        const registry = await loadShippedGeneratedSpriteRegistry();
        if (registry === null || registry.size === 0) {
          throw new Error('retry did not load the shipped registry');
        }
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    try {
      expect(() =>
        execFileSync(process.execPath, [TSX_CLI, '--eval', probe], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30_000,
        }),
      ).not.toThrow();
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });

  it('defaults an omitted runHeadless registry to the shipped art the real game installs', async () => {
    const omitted = await probeHeadlessRegistry(42, 'omitted');
    const replay = await probeHeadlessRegistry(42, 'omitted');
    const explicitNull = await probeHeadlessRegistry(42, { registry: null });

    // MainGameScene always installs the shipped registry; the standard headless
    // call shape now matches it instead of simulating a registry-free world.
    expect(omitted.registryPresent).toBe(true);
    expect(omitted.registryIsShipped).toBe(true);
    expect(omitted.headlessTextureKey).not.toBeNull();
    expect(omitted.headlessTextureKey).toBe(omitted.rendererTextureKey);
    expect(omitted.headlessAnchor).toEqual(omitted.rendererAnchor);
    expect(replay).toEqual(omitted);

    // Explicit null remains the deliberate no-registry override.
    expect(explicitNull.registryPresent).toBe(false);
    expect(explicitNull.headlessTextureKey).toBeNull();

    // Loading the registry must not draw from world.rng: same spawn roll, same
    // downstream gameplay stream.
    expect(omitted.variantRoll).toBe(explicitNull.variantRoll);
    expect(omitted.gameplayRngTail).toEqual(explicitNull.gameplayRngTail);
  });

  it('resolves identical weapon anchors on the render and headless seams', async () => {
    const anchored = await probeHeadlessRegistry(42, { registry: anchoredRegistry });
    const withoutRegistry = await probeHeadlessRegistry(42, { registry: null });

    // An explicitly injected registry still wins over the shipped default.
    expect(anchored.registryIsShipped).toBe(false);
    expect(anchored.headlessTextureKey).toBe(anchored.rendererTextureKey);
    expect(anchored.headlessAnchor).not.toBeNull();
    expect(anchored.headlessAnchor).toEqual(anchored.rendererAnchor);

    expect(withoutRegistry.headlessAnchor).toBeNull();
    expect(anchored.variantRoll).toBe(withoutRegistry.variantRoll);
    expect(anchored.gameplayRngTail).toEqual(withoutRegistry.gameplayRngTail);
  });
});
