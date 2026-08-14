import GUI from 'lil-gui';
import {
  adjustFactionRelation,
  createGameWorld,
  selectFloor2Roster,
  initializeFactionRelations,
  getRelation,
  type GameWorld,
} from '../../core/index.js';
import { SeededRandom } from '../../shared/random.js';
import { BiomeType } from '../../shared/map-types.js';
import type { MapConfig } from '../../shared/map-types.js';
import { CaveSystemGenerator } from '../../core/map/generators/cave-system.js';
import { loadFamilies, type FamilyDef } from '../../shared/data/families.js';
import { loadResources } from '../../shared/data/resources.js';
import {
  initializeFloor2Bosses,
  floor2ObjectiveTick,
  floor2VictorySystem,
  denFavorGoalId,
  isDenUnlocked,
  isFamilySpawnGated,
  markDenUnlocked,
  bossDefeatGoalId,
  FLOOR2_STAIRS_POPPED_GOAL_ID,
  FLOOR2_VICTORY_GOAL_ID,
  type Floor2DenObjective,
} from '../../game/floor2Scenario.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

function createFamilyBossDenLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const families: readonly FamilyDef[] = loadFamilies();
  const resources = loadResources();
  const familyById = new Map(families.map((f) => [f.id, f] as const));

  const state = { seed: 42, presentCount: 4 };

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;line-height:1.55;overflow:auto;max-height:640px;';
  canvasHost.append(panel);

  let world: GameWorld | null = null;
  let objectives: readonly Floor2DenObjective[] = [];

  function findBossEid(w: GameWorld, familyIndex: number): number {
    const bossField = w.stores.familyMembership.isBoss;
    const idxField = w.stores.familyMembership.familyId;
    for (let eid = 0; eid < bossField.length; eid++) {
      if (bossField[eid] === 1 && idxField[eid] === familyIndex) return eid;
    }
    return -1;
  }

  function render(): void {
    if (!world) {
      panel.textContent = 'Not initialised.';
      return;
    }
    const rows: string[] = [];
    const f2 = world.floorExtendedState?.familyState as {
      staircasePos?: { x: number; y: number };
      staircaseSpawned?: boolean;
      staircaseUnlocked?: boolean;
    } | null;
    const victory = world.goalFlags.get(FLOOR2_VICTORY_GOAL_ID) === true;
    const stairsPopped = world.goalFlags.get(FLOOR2_STAIRS_POPPED_GOAL_ID) === true;
    rows.push(`<b>Seed:</b> ${state.seed}  <b>Present families:</b> ${objectives.length}`);
    rows.push(
      `<b>Victory:</b> ${victory ? '✅' : '⏳'}  <b>Stairs popped:</b> ${stairsPopped ? '✅' : '⏳'}`,
    );
    if (f2?.staircasePos) {
      rows.push(
        `<b>Stairs world-pos:</b> (${f2.staircasePos.x.toFixed(1)}, ${f2.staircasePos.y.toFixed(1)})` +
          ` · spawned=${f2.staircaseSpawned === true ? 'yes' : 'no'} unlocked=${f2.staircaseUnlocked === true ? 'yes' : 'no'}`,
      );
    }
    rows.push('');
    for (const obj of objectives) {
      const fam = familyById.get(obj.familyId);
      const name = fam?.name ?? obj.familyId;
      const color = fam?.hudColor ?? '#ccc';
      const unlocked = isDenUnlocked(world, obj.familyId);
      const defeated = world.goalFlags.get(bossDefeatGoalId(obj.familyId)) === true;
      const gated = isFamilySpawnGated(world, obj.familyId);
      const relation = getRelation(world, obj.familyId);
      rows.push(
        `<span style="color:${color}">■</span> <b>${name}</b> [${obj.familyId}]<br>` +
          `&nbsp;&nbsp;archetype: <i>${obj.archetypeId}</i><br>` +
          `&nbsp;&nbsp;relation: <code>${relation}</code><br>` +
          `&nbsp;&nbsp;unlock: <code>${obj.unlockGoalId}</code> — ${unlocked ? '✅' : '⏳'}<br>` +
          `&nbsp;&nbsp;favor route: ${world.goalFlags.get(denFavorGoalId(obj.familyId)) === true ? '🤝 earned' : '—'}<br>` +
          `&nbsp;&nbsp;defeat: <code>${obj.defeatGoalId}</code> — ${defeated ? '☠' : '❤'}<br>` +
          `&nbsp;&nbsp;spawn-gated: ${gated ? '🚫 yes' : '✅ no'}`,
      );
    }
    panel.innerHTML = rows.join('<br>');
  }

  function reseed(): void {
    const w = createGameWorld({ seed: state.seed, floor: 2 });
    w.state = 'playing';
    const rng = new SeededRandom(state.seed);
    const roster = selectFloor2Roster(rng, families, resources, {
      presentCountFourProbability: state.presentCount >= 4 ? 1 : 0,
    });
    initializeFactionRelations(w, roster.presentFamilies);
    w.floorExtendedState = {
      familyState: {
        presentFamilies: roster.presentFamilies.slice(),
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    const gen = new CaveSystemGenerator({ presentCount: roster.presentFamilies.length });
    const floorMap = gen.generate(smallCaveConfig(state.seed), new SeededRandom(state.seed));
    // Assign the generated map to the world so the Force Win actions drive the
    // real stair pop: floor2VictorySystem -> popFloor2ResourceHeartStairs ->
    // findResourceHeartStairTile reads world.floorMap (createGameWorld inits it
    // null, so without this the stairs never pop in the lab).
    w.floorMap = floorMap;
    objectives = initializeFloor2Bosses(w, floorMap, w.floorExtendedState.familyState!);
    world = w;
    render();
  }

  function forceUnlockFirst(): void {
    if (!world || objectives.length === 0) return;
    markDenUnlocked(world, objectives[0]!.familyId);
    render();
  }

  function killFirstBoss(): void {
    if (!world || objectives.length === 0) return;
    const target = objectives[0]!;
    const idx = world.floorExtendedState!.familyState!.presentFamilies.indexOf(target.familyId);
    const bossEid = findBossEid(world, idx);
    if (bossEid < 0) return;
    world.combatEvents.push({
      type: 'death',
      x: 0,
      y: 0,
      amount: 999,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: bossEid,
    } as (typeof world.combatEvents)[number]);
    floor2ObjectiveTick(world);
    render();
  }

  function winFavorFirst(): void {
    if (!world || objectives.length === 0) return;
    // Drive the first family into the Friendly band and run the real objective
    // tick — the FR13 `win-favor` route latches the unlock, not the lab.
    const target = objectives[0]!.familyId;
    adjustFactionRelation(world, target, 100 - getRelation(world, target));
    floor2ObjectiveTick(world);
    render();
  }

  function unlockAll(): void {
    if (!world) return;
    for (const obj of objectives) markDenUnlocked(world, obj.familyId);
    render();
  }

  function forceWinASoleAlly(): void {
    if (!world || objectives.length === 0) return;
    const survivor = objectives[0]!.familyId;
    for (const obj of objectives) {
      if (obj.familyId === survivor) {
        world.factionRelations.set(obj.familyId, 80);
        continue;
      }
      world.factionRelations.set(obj.familyId, 25);
      world.goalFlags.set(bossDefeatGoalId(obj.familyId), true);
      (
        world.floorExtendedState!.familyState as { decapitatedFamilies?: Set<string> }
      ).decapitatedFamilies ??= new Set<string>();
      (
        world.floorExtendedState!.familyState as { decapitatedFamilies?: Set<string> }
      ).decapitatedFamilies!.add(obj.familyId);
    }
    floor2VictorySystem(world);
    render();
  }

  function forceWinBAllBossesDead(): void {
    if (!world) return;
    (
      world.floorExtendedState!.familyState as { decapitatedFamilies?: Set<string> }
    ).decapitatedFamilies ??= new Set<string>();
    for (const obj of objectives) {
      world.goalFlags.set(bossDefeatGoalId(obj.familyId), true);
      (
        world.floorExtendedState!.familyState as { decapitatedFamilies?: Set<string> }
      ).decapitatedFamilies!.add(obj.familyId);
    }
    floor2VictorySystem(world);
    render();
  }

  gui.add(state, 'seed', 1, 999999, 1).name('Seed').onFinishChange(reseed);
  gui.add(state, 'presentCount', [3, 4]).name('Present families').onFinishChange(reseed);
  const actions = {
    reseed,
    forceUnlockFirst,
    winFavorFirst,
    killFirstBoss,
    unlockAll,
    forceWinASoleAlly,
    forceWinBAllBossesDead,
  };
  gui.add(actions, 'reseed').name('Re-init floor');
  gui.add(actions, 'forceUnlockFirst').name('Force unlock first den');
  gui.add(actions, 'winFavorFirst').name('Win favor of first family (peaceful unlock)');
  gui.add(actions, 'killFirstBoss').name('Simulate first boss death');
  gui.add(actions, 'unlockAll').name('Unlock all dens');
  gui.add(actions, 'forceWinASoleAlly').name('Force Win A (sole ally)');
  gui.add(actions, 'forceWinBAllBossesDead').name('Force Win B (all bosses dead)');

  reseed();

  const hint = document.createElement('p');
  hint.textContent =
    'Family Boss Den Lab — den unlocks + boss-defeat spawn-gating + Slice 5 win evaluator / stair pop (FR13–FR16).';
  hint.style.cssText =
    'padding:8px 16px;color:#bfdbfe;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('family-boss-den-lab', {
  category: 'Entities' as LabCategory,
  name: 'Family Boss Den Lab',
  description:
    'Floor 2 boss dens, seeded unlock objectives, boss-defeat spawn-gating, and Slice 5 win-condition stair pop. Drive FR13–FR16 with force actions.',
  create: createFamilyBossDenLab,
});
