import GUI from 'lil-gui';
import {
  createGameWorld,
  selectFloor2Roster,
  initializeFactionRelations,
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
  isDenUnlocked,
  isFamilySpawnGated,
  markDenUnlocked,
  bossDefeatGoalId,
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
    rows.push(`<b>Seed:</b> ${state.seed}  <b>Present families:</b> ${objectives.length}`);
    rows.push('');
    for (const obj of objectives) {
      const fam = familyById.get(obj.familyId);
      const name = fam?.name ?? obj.familyId;
      const color = fam?.hudColor ?? '#ccc';
      const unlocked = isDenUnlocked(world, obj.familyId);
      const defeated = world.goalFlags.get(bossDefeatGoalId(obj.familyId)) === true;
      const gated = isFamilySpawnGated(world, obj.familyId);
      rows.push(
        `<span style="color:${color}">■</span> <b>${name}</b> [${obj.familyId}]<br>` +
          `&nbsp;&nbsp;archetype: <i>${obj.archetypeId}</i><br>` +
          `&nbsp;&nbsp;unlock: <code>${obj.unlockGoalId}</code> — ${unlocked ? '✅' : '⏳'}<br>` +
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
    w.floor2State = {
      presentFamilies: roster.presentFamilies.slice(),
      contestedResource: roster.contestedResource,
      betrayerFlag: false,
    };
    const gen = new CaveSystemGenerator({ presentCount: roster.presentFamilies.length });
    const floorMap = gen.generate(smallCaveConfig(state.seed), new SeededRandom(state.seed));
    objectives = initializeFloor2Bosses(w, floorMap, w.floor2State);
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
    const idx = world.floor2State!.presentFamilies.indexOf(target.familyId);
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

  function unlockAll(): void {
    if (!world) return;
    for (const obj of objectives) markDenUnlocked(world, obj.familyId);
    render();
  }

  gui.add(state, 'seed', 1, 999999, 1).name('Seed').onFinishChange(reseed);
  gui.add(state, 'presentCount', [3, 4]).name('Present families').onFinishChange(reseed);
  const actions = { reseed, forceUnlockFirst, killFirstBoss, unlockAll };
  gui.add(actions, 'reseed').name('Re-init floor');
  gui.add(actions, 'forceUnlockFirst').name('Force unlock first den');
  gui.add(actions, 'killFirstBoss').name('Simulate first boss death');
  gui.add(actions, 'unlockAll').name('Unlock all dens');

  reseed();

  const hint = document.createElement('p');
  hint.textContent =
    'Family Boss Den Lab — sealed dens, seeded unlock objectives, and boss-defeat spawn-gating (FR13/FR14).';
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
    'Floor 2 boss dens, seeded unlock objectives, boss-defeat spawn-gating. Force unlocks + boss deaths to observe the FR13/FR14 pipeline.',
  create: createFamilyBossDenLab,
});
