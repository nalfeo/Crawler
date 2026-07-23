/**
 * Boss Chest Rewards Lab.
 *
 * Exercises the boss-chest lifecycle end to end against the real Floor 2
 * pipeline: `spawnBossChestForDefeatedBoss` (game layer, resolves the
 * deterministic equipment reward bundle at the boss-defeat boundary) then
 * the core-layer state machine in `src/core/systems/bossChestRewards.ts`
 * (`available` → `opening` → `revealed` → `claimed`, via the shared
 * exact-once atomic claim path). Buttons let you drive every transition —
 * including re-opening an already-revealed/claimed chest — so idempotency
 * and fail-closed invalid-state handling are directly observable. See
 * ADR 0070 for the full design.
 */
import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import {
  acknowledgeBossChestReveal,
  openBossChest,
  spawnBossChestForDefeatedBoss,
  type BossChestRecord,
} from '../../game/boss-chest-resolver.js';
import { registerLab, type LabCategory } from '../registry.js';

const LAB_SEED = 11;
const LAB_RUN_KEY = 'bosschestrewards-lab';
const FAMILY_IDS = ['lab-rathmoor', 'lab-vexley'];

const STATE_COLORS: Record<BossChestRecord['state'], string> = {
  available: '#9ca3af',
  opening: '#f59e0b',
  revealed: '#3b82f6',
  claimed: '#22c55e',
};

function enableFloor2Economy(world: GameWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

function createBossChestRewardsLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  let world: GameWorld;
  let playerEid: number;
  const log: string[] = [];

  const root = document.createElement('div');
  root.style.cssText =
    'padding:24px; height:100%; overflow:auto; color:#f8fafc; font-family:monospace;';
  canvasHost.append(root);

  function reset(): void {
    world = createGameWorld({
      seed: LAB_SEED,
      floor: 2,
      entityCapacityMode: 'lab',
      generatedEquipmentRunKey: LAB_RUN_KEY,
    });
    enableFloor2Economy(world);
    playerEid = spawnPlayer(world, 0, 0);
    log.length = 0;
    log.push('Reset — Floor 2, economy enabled, player spawned.');
    for (const familyId of FAMILY_IDS) {
      const spawned = spawnBossChestForDefeatedBoss(world, familyId);
      log.push(
        spawned.created
          ? `Boss "${familyId}" defeated → chest ${spawned.chest.chestId} created (${spawned.chest.state}).`
          : `Boss "${familyId}" defeat ignored: ${spawned.reason}.`,
      );
    }
    render();
  }

  function render(): void {
    root.innerHTML = '<h2 style="margin:0 0 12px">💀 Boss Chest Rewards</h2>';
    const chests = [...world.bossChests.values()];
    if (chests.length === 0) {
      const empty = document.createElement('p');
      empty.style.color = '#9ca3af';
      empty.textContent = 'No boss chests yet.';
      root.append(empty);
    }
    for (const chest of chests) {
      const color = STATE_COLORS[chest.state];
      const bundle = world.generatedEquipmentRewardBundles.get(chest.chestId);
      const row = document.createElement('div');
      row.style.cssText = `display:flex; justify-content:space-between; align-items:center; gap:16px; padding:10px 12px; margin-bottom:8px; border:1px solid ${color}; border-radius:8px; background:rgba(255,255,255,0.04);`;
      const left = document.createElement('div');
      left.innerHTML = `<div style="color:${color};font-weight:bold">${chest.chestId}</div><div style="font-size:12px;color:#9ca3af">family: ${chest.familyId} · state: <b style="color:${color}">${chest.state}</b> · bundle instances: ${bundle?.instanceKeys.length ?? 0}</div>`;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex; gap:8px;';

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => {
        const result = openBossChest(world, chest.chestId, playerEid);
        log.push(`openBossChest(${chest.chestId}) → ${JSON.stringify(result)}`);
        render();
      });

      const ackBtn = document.createElement('button');
      ackBtn.textContent = 'Acknowledge';
      ackBtn.addEventListener('click', () => {
        const result = acknowledgeBossChestReveal(world, chest.chestId);
        log.push(`acknowledgeBossChestReveal(${chest.chestId}) → ${JSON.stringify(result)}`);
        render();
      });

      btns.append(openBtn, ackBtn);
      row.append(left, btns);
      root.append(row);
    }

    const logHeading = document.createElement('h3');
    logHeading.style.cssText = 'margin:16px 0 6px; font-size:13px; color:#9ca3af;';
    logHeading.textContent = 'Event log (newest last)';
    root.append(logHeading);
    const logBox = document.createElement('pre');
    logBox.style.cssText =
      'font-size:11px; color:#c9c9c9; background:#0d0d14; padding:10px; border-radius:6px; white-space:pre-wrap;';
    logBox.textContent = log.slice(-12).join('\n');
    root.append(logBox);
  }

  if (gui instanceof GUI) {
    gui
      .add(
        {
          reset: () => reset(),
        },
        'reset',
      )
      .name('Reset (new run)');
    gui
      .add(
        {
          claimTwice: () => {
            const chest = [...world.bossChests.values()].find((c) => c.state === 'available');
            if (!chest) {
              log.push('Open first chest twice: no available chest — reset first.');
              render();
              return;
            }
            openBossChest(world, chest.chestId, playerEid);
            const second = openBossChest(world, chest.chestId, playerEid);
            log.push(`Duplicate open of ${chest.chestId} → ${JSON.stringify(second)}`);
            render();
          },
        },
        'claimTwice',
      )
      .name('Open first chest twice (idempotency)');
    gui
      .add(
        {
          invalidAck: () => {
            const chest = [...world.bossChests.values()].find((c) => c.state === 'available');
            if (!chest) {
              log.push('Acknowledge before open (fail-closed): no available chest — reset first.');
              render();
              return;
            }
            const result = acknowledgeBossChestReveal(world, chest.chestId);
            log.push(
              `Acknowledge before open on ${chest.chestId} (fail-closed) → ${JSON.stringify(result)}`,
            );
            render();
          },
        },
        'invalidAck',
      )
      .name('Acknowledge before open (fail-closed)');
  }

  reset();
  return () => root.remove();
}

registerLab('bosschestrewards-lab', {
  category: 'Progression' as LabCategory,
  name: 'Boss Chest Rewards Lab',
  description:
    'Floor 2 boss-defeat → chest-creation → open → acknowledge lifecycle, driven through the real spawnBossChestForDefeatedBoss / openBossChest / acknowledgeBossChestReveal pipeline. Buttons expose duplicate-open idempotency and fail-closed invalid-transition handling.',
  create: createBossChestRewardsLab,
});
