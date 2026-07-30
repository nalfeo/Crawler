import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { floor1EnemyPack, floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import {
  ARENA_ENEMY_PRESETS,
  ARENA_ROOM_PRESETS,
  ALL_ARCHETYPES,
  archetypeToAiType,
  findWalkablePosition,
  getEnemyPreset,
  spawnFromArchetype,
  spawnPresetAroundCenter,
  FLOOR2_FAMILY_IDS,
} from '../../src/labs/combat-arena-lab/arena-data.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { runCoreSimulationStep } from '../../src/core/simulation-core-step.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { enemyAISystem, weaponSystem } from '../../src/game/index.js';
import { createInputState } from '../../src/shared/input.js';
import { SeededRandom } from '../../src/shared/random.js';

describe('combat-arena-lab wiring', () => {
  // ── Source-level checks ────────────────────────────────────────────────────

  it('is registered in LAB_MODULE_PATHS in lab-main.ts', () => {
    const labMain = readFileSync('src/lab-main.ts', 'utf-8');
    expect(labMain).toContain("'combat-arena-lab': '/src/labs/combat-arena-lab/index.ts'");
  });

  it('declares the correct LAB_ID in index.ts', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain("const LAB_ID = 'combat-arena-lab';");
  });

  it('registers the lab with category Combat', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('registerLab(LAB_ID,');
    expect(source).toContain("category: 'Combat'");
    expect(source).toContain("name: 'Combat Arena'");
  });

  it('uses runCoreSimulationStep instead of manual system dispatch', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('runCoreSimulationStep(');
    expect(source).not.toContain('playerInputSystem(');
    expect(source).not.toContain('movementSystem(');
  });

  it('runs statusEffectSystem before mobAbilitySystem so Tarnished expires', () => {
    // Regression guard: the arena enables the mob-ability runtime, so its
    // preSystems must also tick statusEffectSystem (and before mobAbilitySystem,
    // matching the canonical floor order) or debuffs like Tarnished never expire.
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    const statusIdx = source.indexOf('statusEffectSystem, mobAbilitySystem');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
  });

  it('creates, syncs, and destroys the HUD announcement banner', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('createHudAnnouncementBanner(this)');
    expect(source).toContain('this.announcementBanner.sync(this.world);');
    expect(source).toContain('this.announcementBanner?.destroy();');
  });

  it('uses crypto.getRandomValues instead of Date.now for RNG seed', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('globalThis.crypto.getRandomValues(');
    // Only check that Date.now() is not used as a seed (comments mentioning it are fine)
    const nonCommentLines = source.split('\n').filter((line) => !line.trimStart().startsWith('//'));
    expect(nonCommentLines.some((line) => line.includes('Date.now()'))).toBe(false);
  });

  it('supports player modes: hero, observer, and immortal', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain("'hero'");
    expect(source).toContain("'observer'");
    expect(source).toContain("'immortal'");
    expect(source).toContain('PLAYER_HP_HERO');
    expect(source).toContain('ARENA_OBSERVER_PLAYER_HP');
    expect(source).toContain('clearActiveWeaponDef(this.world);');
  });

  it('supports simulation speed controls', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('simSpeed');
    expect(source).toContain("'1x': 1");
    expect(source).toContain("'4x': 4");
    expect(source).toContain("'16x': 16");
    expect(source).toContain('togglePause');
    expect(source).toContain('stepFrame');
  });

  it('supports custom mob placement mode', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('customModeActive');
    expect(source).toContain('customMobId');
    expect(source).toContain("'Click-to-Place Mode'");
    expect(source).toContain('spawnCustomMobAtCenter');
  });

  it('wires floor filter to filter enemy preset dropdown', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('floorFilter');
    expect(source).toContain('buildPresetOptions');
    expect(source).toContain('refreshPresetDropdown');
  });

  it('exposes arenaSeed in settings for reproducibility', () => {
    const source = readFileSync('src/labs/combat-arena-lab/index.ts', 'utf-8');
    expect(source).toContain('arenaSeed');
    expect(source).toContain('newSeed');
  });

  // ── arena-data.ts: room preset validation ─────────────────────────────────

  it('has at least five room presets', () => {
    expect(ARENA_ROOM_PRESETS.length).toBeGreaterThanOrEqual(5);
  });

  it('room preset ids are unique', () => {
    const ids = ARENA_ROOM_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes boss-arena, small-room, columns-room, corridor, and cave presets', () => {
    const ids = new Set(ARENA_ROOM_PRESETS.map((p) => p.id));
    expect(ids.has('boss-arena')).toBe(true);
    expect(ids.has('small-room')).toBe(true);
    expect(ids.has('columns-room')).toBe(true);
    expect(ids.has('corridor')).toBe(true);
    expect(ids.has('cave')).toBe(true);
  });

  it('every room preset builds a valid FloorMap with correct dimensions', () => {
    for (const preset of ARENA_ROOM_PRESETS) {
      const map = preset.buildMap();
      expect(map).toBeDefined();
      expect(map.widthFt).toBeGreaterThan(0);
      expect(map.heightFt).toBeGreaterThan(0);
    }
  });

  it('player spawn tile is passable for every room preset', () => {
    for (const preset of ARENA_ROOM_PRESETS) {
      const map = preset.buildMap();
      const spawnFt = map.tileToWorld(preset.playerSpawnTile.x, preset.playerSpawnTile.y);
      expect(
        map.isPassableAt(spawnFt.x, spawnFt.y),
        `${preset.id}: playerSpawnTile is inside a wall`,
      ).toBe(true);
    }
  });

  // ── arena-data.ts: enemy preset validation ────────────────────────────────

  it('has floor-1 enemy presets', () => {
    const f1 = ARENA_ENEMY_PRESETS.filter((p) => p.floor === 'floor1');
    expect(f1.length).toBeGreaterThanOrEqual(3);
  });

  it('has floor-2 family presets', () => {
    const f2 = ARENA_ENEMY_PRESETS.filter((p) => p.floor === 'floor2');
    expect(f2.length).toBeGreaterThanOrEqual(5);
  });

  it('has a custom blank preset', () => {
    const custom = ARENA_ENEMY_PRESETS.find((p) => p.id === 'custom');
    expect(custom).toBeDefined();
    expect(custom?.entries).toHaveLength(0);
  });

  it('enemy preset ids are unique', () => {
    const ids = ARENA_ENEMY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('floor-2 presets include boss entries', () => {
    const f2 = ARENA_ENEMY_PRESETS.filter((p) => p.floor === 'floor2');
    const presetWithBoss = f2.find((p) => p.entries.some((e) => e.def.isBoss === true));
    expect(presetWithBoss).toBeDefined();
  });

  it('includes the sovereign-cap boss ability preset', () => {
    const preset = ARENA_ENEMY_PRESETS.find((p) => p.id === 'f2-sovereign-cap');
    expect(preset).toBeDefined();
    expect(preset?.customSpawnFn).toBeTypeOf('function');
  });

  it('includes the canonical Squick boss-ability preset', () => {
    const preset = getEnemyPreset('f2-squick');
    expect(preset.id).toBe('f2-squick');
    expect(preset.customSpawnFn).toBeTypeOf('function');
  });

  it('includes the canonical Big Mama Bufo boss-ability preset', () => {
    const preset = getEnemyPreset('f2-big-mama-bufo');
    expect(preset.id).toBe('f2-big-mama-bufo');
    expect(preset.customSpawnFn).toBeTypeOf('function');
  });

  // ── arena-data.ts: ALL_ARCHETYPES ─────────────────────────────────────────

  it('ALL_ARCHETYPES contains archetypes from floor1 and floor2', () => {
    expect(ALL_ARCHETYPES.length).toBeGreaterThanOrEqual(5);
    expect(ALL_ARCHETYPES.some((a) => a.id === 'rat')).toBe(true);
    expect(ALL_ARCHETYPES.some((a) => a.id === 'slime')).toBe(true);
  });

  it('FLOOR2_FAMILY_IDS has entries for multiple families', () => {
    expect(FLOOR2_FAMILY_IDS.length).toBeGreaterThanOrEqual(5);
  });

  // ── arena-data.ts: archetypeToAiType ─────────────────────────────────────

  it('archetypeToAiType returns RANGED for ranged archetypes', () => {
    const ranged = floor2EnemyPack.archetypes.find((a) => a.aiType === 'ranged');
    if (ranged) {
      expect(archetypeToAiType(ranged)).toBe(AI_TYPE.RANGED);
    }
  });

  it('archetypeToAiType returns LEAPER for slime archetypes', () => {
    const slime = floor1EnemyPack.archetypes.find((a) => a.id === 'slime');
    expect(slime).toBeDefined();
    expect(archetypeToAiType(slime!)).toBe(AI_TYPE.LEAPER);
  });

  it('archetypeToAiType returns CHASE for melee archetypes like rat', () => {
    const rat = floor1EnemyPack.archetypes.find((a) => a.id === 'rat');
    expect(rat).toBeDefined();
    expect(archetypeToAiType(rat!)).toBe(AI_TYPE.CHASE);
  });

  // ── arena-data.ts: findWalkablePosition ────────────────────────────────────

  it('findWalkablePosition snaps out-of-wall positions to walkable tiles', () => {
    const rng = new SeededRandom(1234);
    const bossArena = ARENA_ROOM_PRESETS.find((p) => p.id === 'boss-arena')!;
    const map = bossArena.buildMap();
    // Top-left corner (0, 0) in world feet is on a wall tile
    const wallFt = map.tileToWorld(0, 0);
    const result = findWalkablePosition(map, wallFt.x + 1, wallFt.y + 1, rng);
    expect(map.isPassableAt(result.x, result.y)).toBe(true);
  });

  it('findWalkablePosition returns the original position when already walkable', () => {
    const rng = new SeededRandom(5678);
    const bossArena = ARENA_ROOM_PRESETS.find((p) => p.id === 'boss-arena')!;
    const map = bossArena.buildMap();
    const spawnFt = map.tileToWorld(17, 12);
    expect(map.isPassableAt(spawnFt.x, spawnFt.y)).toBe(true);
    const result = findWalkablePosition(map, spawnFt.x, spawnFt.y, rng);
    expect(result.x).toBe(spawnFt.x);
    expect(result.y).toBe(spawnFt.y);
  });

  // ── arena-data.ts: spawnFromArchetype headless simulation ─────────────────

  it('spawnFromArchetype creates entity with correct HP and position', () => {
    const rng = new SeededRandom(12345);
    const world = createTestWorld({ seed: rng.nextInt(1, 99999) });
    const rat = floor1EnemyPack.archetypes.find((a) => a.id === 'rat')!;

    const bossArena = ARENA_ROOM_PRESETS.find((p) => p.id === 'boss-arena')!;
    const map = bossArena.buildMap();
    const spawnFt = map.tileToWorld(17, 12);
    world.floorMap = map;

    const eid = spawnFromArchetype(world, spawnFt.x, spawnFt.y, rat);
    expect(eid).toBeGreaterThanOrEqual(0);
    expect(world.stores.health.current[eid]).toBe(rat.hp);
    expect(world.stores.position.x[eid]).toBe(spawnFt.x);
    expect(world.stores.position.y[eid]).toBe(spawnFt.y);
  });

  it('spawnFromArchetype sets non-zero attackRange for ranged archetypes', () => {
    const rng = new SeededRandom(99999);
    const world = createTestWorld({ seed: rng.nextInt(1, 99999) });
    const rangedDef = floor2EnemyPack.archetypes.find((a) => a.aiType === 'ranged');
    if (!rangedDef) return; // skip if pack has no ranged archetype

    const eid = spawnFromArchetype(world, 40, 40, rangedDef);
    // EnemyBehavior.attackRange should be > 0 for ranged archetypes
    expect(world.stores.enemyBehavior.attackRange[eid]).toBeGreaterThan(0);
  });

  it('floor1 enemy pack has rat and slime archetypes with valid stats', () => {
    const rat = floor1EnemyPack.archetypes.find((a) => a.id === 'rat');
    const slime = floor1EnemyPack.archetypes.find((a) => a.id === 'slime');
    expect(rat).toBeDefined();
    expect(slime).toBeDefined();
    expect(rat!.hp).toBeGreaterThan(0);
    expect(slime!.hp).toBeGreaterThan(0);
  });

  it('floor2 enemy pack has boss archetypes for multiple families', () => {
    const bosses = floor2EnemyPack.archetypes.filter((a) => a.isBoss === true);
    expect(bosses.length).toBeGreaterThanOrEqual(5);
    for (const boss of bosses) {
      expect(boss.familyId).toBeTruthy();
    }
  });

  it('spawnPresetAroundCenter routes f2 boss entries through production-compatible spawn: scaled HP, contact damage 2, family tag', () => {
    // Find the first f2 preset that has a RANGED boss entry so all production-parity
    // behaviors are exercised, including the max(160, detectRange × 4) attack range branch.
    const f2Preset = ARENA_ENEMY_PRESETS.find(
      (p) =>
        p.floor === 'floor2' &&
        p.entries.some((e) => e.def.isBoss === true && e.def.aiType === 'ranged'),
    );
    expect(f2Preset).toBeDefined();
    if (!f2Preset) return;

    const bossEntry = f2Preset.entries.find(
      (e) => e.def.isBoss === true && e.def.aiType === 'ranged',
    )!;
    const bossDef = bossEntry.def;

    const rng = new SeededRandom(42424);
    const world = createTestWorld({ seed: rng.nextInt(1, 99999) });
    const bossArena = ARENA_ROOM_PRESETS.find((p) => p.id === 'boss-arena')!;
    const map = bossArena.buildMap();
    world.floorMap = map;

    const centerPt = map.tileToWorld(Math.floor(map.width / 2), Math.floor(map.height / 2));
    const eids = spawnPresetAroundCenter(world, map, f2Preset, centerPt.x, centerPt.y, rng);
    expect(eids.length).toBeGreaterThan(0);

    // Find the boss entity — it should have FamilyMembership.isBoss = 1
    const bossEid = eids.find((eid) => (world.stores.familyMembership.isBoss[eid] ?? 0) === 1);
    expect(bossEid).toBeDefined();
    if (bossEid === undefined) return;

    // HP must be scaled by 0.03 (production spawnFamilyBoss scale), clamped to ≥ 1
    const expectedHp = Math.max(1, Math.round(bossDef.hp * 0.03));
    expect(world.stores.health.current[bossEid]).toBe(expectedHp);

    // Contact damage must be 2 (not fallback 5 from generic spawnFromArchetype)
    expect(world.stores.damage.amount[bossEid]).toBe(2);

    // FamilyMembership.isBoss must be set to 1
    expect(world.stores.familyMembership.isBoss[bossEid]).toBe(1);

    // If the boss is ranged, attack range must be ≥ 160 (max(160, detectRange × 4))
    // This is guaranteed to execute because we selected a ranged boss above.
    const expectedRange = Math.max(160, bossDef.detectRange * 4);
    expect(world.stores.enemyBehavior.attackRange[bossEid]).toBe(expectedRange);
  });

  it('headless arena pipeline: spawn preset + run simulation steps without crash', () => {
    const rng = new SeededRandom(77777);
    const world = createTestWorld({ seed: rng.nextInt(1, 99999) });
    const bossArena = ARENA_ROOM_PRESETS.find((p) => p.id === 'boss-arena')!;
    const map = bossArena.buildMap();
    world.floorMap = map;

    // Spawn player at the preset's spawn tile
    const spawnTile = bossArena.playerSpawnTile;
    const spawnPt = map.tileToWorld(spawnTile.x, spawnTile.y);
    const playerEid = spawnPlayer(world, spawnPt.x, spawnPt.y);
    expect(playerEid).toBeGreaterThanOrEqual(0);

    // Spawn f1-rats preset around center
    const centerPt = map.tileToWorld(Math.floor(map.width / 2), Math.floor(map.height / 2));
    const f1RatsPreset = getEnemyPreset('f1-rats');
    const enemyEids = spawnPresetAroundCenter(
      world,
      map,
      f1RatsPreset,
      centerPt.x,
      centerPt.y,
      rng,
    );
    expect(enemyEids.length).toBeGreaterThan(0);

    // Record initial enemy HP to verify simulation is advancing state
    const initialEnemyHp = enemyEids.map((eid) => world.stores.health.current[eid] ?? 0);
    const inputState = createInputState();

    // Run 10 deterministic simulation steps — same pipeline as the visual scene
    for (let i = 0; i < 10; i++) {
      world.frameCount += 1;
      world.elapsedMs += 16;
      runCoreSimulationStep(world, inputState, {
        preSystems: [weaponSystem, enemyAISystem],
      });
    }

    // World is still in a valid state after stepping
    expect(world.state).not.toBe('error');
    // At least one enemy should still exist (frame count too low to kill all 5 rats)
    const stillAlive = enemyEids.filter((eid) => (world.stores.health.current[eid] ?? 0) > 0);
    expect(stillAlive.length).toBeGreaterThan(0);
    // Simulation advanced frame counter
    expect(world.frameCount).toBe(10);
    // HP values are numbers (not undefined/NaN)
    for (let i = 0; i < enemyEids.length; i++) {
      const hp = world.stores.health.current[enemyEids[i]!] ?? 0;
      expect(Number.isFinite(hp)).toBe(true);
      // At most equal to initial — enemies take damage or remain unscathed, never gain HP
      expect(hp).toBeLessThanOrEqual(initialEnemyHp[i]! + 0.01);
    }
  });
});
