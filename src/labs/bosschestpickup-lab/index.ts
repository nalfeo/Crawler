/**
 * Boss Chest Pickup Lab — sandbox for the proximity-based boss chest auto-open system.
 *
 * Spawns a player and a boss chest entity in the world and drives
 * `bossChestPickupSystem` each tick. Click "Teleport to chest" to move the
 * player on top of the chest and trigger auto-open.
 */
import { registerLab } from '../registry.js';
import { entityExists, removeEntity } from 'bitecs';
import { createGameWorld, spawnPlayer } from '../../core/index.js';
import { clearEntityStores } from '../../core/helpers.js';
import { bossChestPickupSystem } from '../../core/systems/bossChestPickupSystem.js';
import { createBossChestId } from '../../core/systems/bossChestRewards.js';
import { spawnBossChestForDefeatedBoss } from '../../game/boss-chest-resolver.js';

const CHEST_X = 20;
const CHEST_Y = 20;
const PLAYER_START_X = 40;
const PLAYER_START_Y = 40;
const FAMILY_ID = 'ratfolk';

registerLab('bosschestpickup-lab', {
  name: 'Boss Chest Pickup',
  description:
    'Proximity-based boss chest auto-open. Teleport the player to the chest to trigger pickup.',
  category: 'Items & Equipment',
  create(_canvas: HTMLElement, controls: HTMLElement) {
    const world = createGameWorld({
      seed: 1,
      floor: 2,
      entityCapacityMode: 'lab',
    });
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;

    const playerEid = spawnPlayer(world, PLAYER_START_X, PLAYER_START_Y);

    let chestId = '';
    let chestEid = -1;

    function spawnChest(): void {
      const id = createBossChestId(FAMILY_ID);
      chestId = id;
      const spawned = spawnBossChestForDefeatedBoss(world, FAMILY_ID, CHEST_X, CHEST_Y);
      if (!spawned.created) {
        throw new Error(`bosschestpickup-lab failed to spawn chest: ${spawned.reason}`);
      }
      chestEid = world.bossChestEids.get(id) ?? -1;
    }

    function reset(): void {
      if (chestId) {
        const existingEid = world.bossChestEids.get(chestId);
        if (existingEid !== undefined && entityExists(world.ecs, existingEid)) {
          clearEntityStores(world, existingEid);
          removeEntity(world.ecs, existingEid);
        }
        world.bossChestEids.delete(chestId);
        world.bossChests.delete(chestId);
        world.generatedEquipmentRewardBundles.delete(chestId);
      }
      const pos = world.stores.position;
      pos.x[playerEid] = PLAYER_START_X;
      pos.y[playerEid] = PLAYER_START_Y;
      spawnChest();
      renderStatus();
    }

    spawnChest();

    const statusEl = document.createElement('pre');
    statusEl.style.cssText =
      'font-family:monospace;font-size:13px;background:#111;color:#eee;padding:12px;border-radius:4px;white-space:pre;';

    function renderStatus(): void {
      const chest = world.bossChests.get(chestId);
      chestEid = world.bossChestEids.get(chestId) ?? chestEid;
      const pos = world.stores.position;
      const px = (pos.x[playerEid] ?? 0).toFixed(1);
      const py = (pos.y[playerEid] ?? 0).toFixed(1);
      const cx = (pos.x[chestEid] ?? 0).toFixed(1);
      const cy = (pos.y[chestEid] ?? 0).toFixed(1);
      statusEl.textContent = [
        `Chest ID:    ${chestId}`,
        `Chest pos:   (${cx}, ${cy}) ft`,
        `Chest state: ${chest?.state ?? 'gone (picked up)'}`,
        `Player pos:  (${px}, ${py}) ft`,
        `Eid in map:  ${world.bossChestEids.has(chestId)}`,
      ].join('\n');
    }

    const teleportBtn = document.createElement('button');
    teleportBtn.textContent = 'Teleport player to chest';
    teleportBtn.style.marginRight = '8px';
    teleportBtn.addEventListener('click', () => {
      const pos = world.stores.position;
      pos.x[playerEid] = CHEST_X;
      pos.y[playerEid] = CHEST_Y;
    });

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', reset);

    controls.appendChild(teleportBtn);
    controls.appendChild(resetBtn);
    controls.appendChild(statusEl);

    let rafId = 0;
    function tick(): void {
      bossChestPickupSystem(world);
      renderStatus();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
    };
  },
});
