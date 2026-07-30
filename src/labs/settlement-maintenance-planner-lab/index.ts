/**
 * Settlement Maintenance Planner Lab.
 *
 * Exercises `runSettlementMaintenancePlanner` end to end against a real
 * Floor 2 world: a settlement room, unlocked-but-unclaimed achievements, an
 * available boss chest, a seeded Quartermaster stock, and starting gold.
 * Buttons let you step the planner, move the player in/out of the
 * settlement room (to observe the opportunity latch), and inspect the full
 * decision telemetry log for one run.
 */
import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import { safeRoomSystem } from '../../core/safe-space.js';
import { makeMapWithSafeRoom } from '../../../tests/helpers/map-fixtures.js';
import { unlockAchievement } from '../../game/systems/achievementSystem.js';
import { spawnBossChestForDefeatedBoss } from '../../game/boss-chest-resolver.js';
import { createInitialFloor2QuartermasterStock } from '../../game/quartermaster-stock.js';
import type { Floor2SettlementSnapshot } from '../../shared/floor-types.js';
import { runSettlementMaintenancePlanner } from '../../game/ai/settlement-maintenance-planner.js';
import type { SettlementMaintenanceResult } from '../../game/ai/settlement-maintenance-types.js';
import { registerLab, type LabCategory } from '../registry.js';

const LAB_SEED = 77;
const LAB_RUN_KEY = 'settlement-maintenance-lab';

function enableFloor2Economy(world: GameWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

function createSettlementMaintenanceLab(
  canvasHost: HTMLElement,
  controls: HTMLElement,
): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  let world: GameWorld;
  let playerEid: number;
  let inSettlement = true;
  const log: string[] = [];

  const root = document.createElement('div');
  root.style.cssText =
    'padding:24px; height:100%; overflow:auto; color:#f8fafc; font-family:monospace;';
  canvasHost.append(root);

  const floorMap = makeMapWithSafeRoom({ widthTiles: 12, heightTiles: 12, spawn: { x: 2, y: 2 } });
  const settlementRoomId = 0; // first (and only) room added by makeMapWithSafeRoom

  function reset(): void {
    world = createGameWorld({
      seed: LAB_SEED,
      floor: 2,
      entityCapacityMode: 'lab',
      generatedEquipmentRunKey: LAB_RUN_KEY,
    });
    enableFloor2Economy(world);
    world.floorMap = floorMap;
    playerEid = spawnPlayer(world, 0, 0);
    world.playerGold = 5_000;
    world.playerLevel.level = 5;
    inSettlement = true;
    placePlayer();

    const stock = createInitialFloor2QuartermasterStock(world);
    const settlement: Floor2SettlementSnapshot = {
      settlementRoomId,
      settlementRoomIds: [settlementRoomId],
      brokerEid: 1,
      defectorEid: 2,
      defectorFamilyId: 'lab-family',
      defectorAppearanceKey: 'goblin-brute',
      defectorFallbackAppearanceKey: 'goblin',
      quartermasterShop: {
        archetypeId: 'quartermaster',
        npcId: 'quartermaster',
        npcEid: 3,
        inventory: [],
      },
      quartermasterStock: stock ?? undefined,
      shops: [],
    };
    world.floorExtendedState = { settlement };

    unlockAchievement(world, 'first-bonk');
    unlockAchievement(world, 'slime-no-more');
    const chestSpawn = spawnBossChestForDefeatedBoss(world, 'lab-family');

    log.length = 0;
    log.push(
      `Reset — settlement room, 2 unclaimed achievements, boss chest (${chestSpawn.created ? 'created' : chestSpawn.reason}), gold=5000.`,
    );
    render();
  }

  function placePlayer(): void {
    const center = floorMap.tileToWorld(2, 2); // interior of the SAFE room (1,1)-(4,4)
    const outside = floorMap.tileToWorld(9, 9);
    const target = inSettlement ? center : outside;
    world.stores.position.x[playerEid] = target.x;
    world.stores.position.y[playerEid] = target.y;
    // Mirror the real per-frame pipeline: safeRoomSystem derives
    // world.playerInSafeRoom from the player's current position, which
    // isInSafeContext (and therefore equipFromBag/purchase gating) depends
    // on. Without this, the lab's "Run Planner" button would silently never
    // equip/purchase anything, even while standing in a real SAFE room.
    world.state = 'playing';
    safeRoomSystem(world);
  }

  function describe(result: SettlementMaintenanceResult): string {
    const lines = [
      `ran=${result.ran} terminationReason=${result.terminationReason} decisions=${result.decisions.length}`,
      ...result.decisions.map((d) => `  [${d.kind}] ${d.detail}`),
    ];
    return lines.join('\n');
  }

  function render(): void {
    root.innerHTML = '<h2 style="margin:0 0 12px">🏘️ Settlement Maintenance Planner</h2>';
    const status = document.createElement('p');
    status.style.color = '#9ca3af';
    status.textContent = `Player in settlement: ${inSettlement} · gold: ${world.playerGold}`;
    root.append(status);

    const logHeading = document.createElement('h3');
    logHeading.style.cssText = 'margin:16px 0 6px; font-size:13px; color:#9ca3af;';
    logHeading.textContent = 'Event log (newest last)';
    root.append(logHeading);
    const logBox = document.createElement('pre');
    logBox.style.cssText =
      'font-size:11px; color:#c9c9c9; background:#0d0d14; padding:10px; border-radius:6px; white-space:pre-wrap;';
    logBox.textContent = log.slice(-40).join('\n');
    root.append(logBox);
  }

  if (gui instanceof GUI) {
    gui.add({ reset: () => reset() }, 'reset').name('Reset (new run)');
    gui
      .add(
        {
          toggleLocation: () => {
            inSettlement = !inSettlement;
            placePlayer();
            log.push(`Moved player ${inSettlement ? 'INTO' : 'OUT OF'} the settlement room.`);
            render();
          },
        },
        'toggleLocation',
      )
      .name('Toggle in/out of settlement');
    gui
      .add(
        {
          runPlanner: () => {
            const result = runSettlementMaintenancePlanner(world);
            log.push(`runSettlementMaintenancePlanner() →\n${describe(result)}`);
            render();
          },
        },
        'runPlanner',
      )
      .name('Run planner (tick)');
  }

  reset();
  return () => root.remove();
}

registerLab('settlement-maintenance-planner-lab', {
  category: 'Progression' as LabCategory,
  name: 'Settlement Maintenance Planner Lab',
  description:
    'Deterministic AI settlement-maintenance planner: achievement/boss-chest claims, greedy equipment swap + Quartermaster purchase, and ability configuration, all through the real shared APIs. Toggle in/out of the settlement room to observe the once-per-visit opportunity latch.',
  create: createSettlementMaintenanceLab,
});
