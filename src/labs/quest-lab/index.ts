import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { addItem } from '../../shared/inventory.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  SHOPKEEPER_FETCH_ITEM_ID,
  getQuestDef,
} from '../../shared/quest-types.js';
import {
  acceptQuest,
  getActiveQuests,
  getQuestObjectiveViews,
  notifyQuestTalk,
  questSystem,
  setQuestCounter,
  setTrackedQuest,
} from '../../core/systems/questSystem.js';
import {
  returnShopkeeperPrize,
  purchaseShopkeeperEquipment,
  equipPurchasedGear,
  getShopkeeperStage,
  SHOPKEEPER_EQUIPMENT_COST,
} from '../../game/floor1Scenario.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 4242;

function createQuestLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const world: GameWorld = createGameWorld({ seed: LAB_SEED });
  world.state = 'playing';
  const playerEid = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, playerEid);
  acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
  acceptQuest(world, FLOOR1_SHOP_QUEST_ID);

  let ratsKilled = 0;
  let slimesKilled = 0;

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;line-height:1.5;overflow:auto;max-height:560px;';
  canvasHost.append(panel);

  function tick(): void {
    setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', ratsKilled);
    setQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', slimesKilled);
    questSystem(world);
    render();
  }

  function render(): void {
    const lines: string[] = [];
    lines.push(`<b>Player gold:</b> ${world.playerGold}`);
    lines.push(
      `<b>Unlocks:</b> inventory=${world.featureUnlocks.inventory} equipment=${world.featureUnlocks.equipment}`,
    );
    lines.push(`<b>Shopkeeper stage:</b> ${getShopkeeperStage(world)}`);
    lines.push('');
    for (const quest of getActiveQuests(world)) {
      const def = getQuestDef(quest.questId);
      const marker = quest.tracked ? '◆' : '◇';
      lines.push(`${marker} <b>${def?.title ?? quest.questId}</b> [${quest.status}]`);
      for (const view of getQuestObjectiveViews(world, quest, playerEid)) {
        if (view.hidden) {
          lines.push(`&nbsp;&nbsp;&nbsp;<span style="color:#555">… hidden …</span>`);
          continue;
        }
        const box = view.complete ? '☑' : '☐';
        const color = view.complete ? '#6ee7b7' : view.active ? '#ffffff' : '#e5e7eb';
        const count =
          view.target > 1 ? ` (${Math.min(view.current, view.target)}/${view.target})` : '';
        lines.push(
          `&nbsp;&nbsp;<span style="color:${color}">${box} ${view.def.label}${count}</span>`,
        );
      }
      lines.push('');
    }
    panel.innerHTML = lines.join('<br/>');
  }

  const actions = {
    killRat: () => {
      ratsKilled += 1;
      tick();
    },
    killSlime: () => {
      slimesKilled += 1;
      tick();
    },
    reachLevel2: () => {
      world.goalFlags.set('floor1-reach-level-2', true);
      acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);
      tick();
    },
    meetMerchant: () => {
      notifyQuestTalk(world, 'shopkeeper');
      tick();
    },
    pickUpRatTail: () => {
      const bag = world.inventories.get(playerEid);
      if (bag) {
        addItem(bag, SHOPKEEPER_FETCH_ITEM_ID, 1);
      }
      tick();
    },
    returnPrize: () => {
      returnShopkeeperPrize(world, playerEid);
      tick();
    },
    addGold: () => {
      world.playerGold += SHOPKEEPER_EQUIPMENT_COST;
      tick();
    },
    buyEquipment: () => {
      purchaseShopkeeperEquipment(world, playerEid);
      tick();
    },
    equipGear: () => {
      equipPurchasedGear(world, playerEid);
      tick();
    },
    trackTutorial: () => {
      setTrackedQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
      render();
    },
    trackShop: () => {
      setTrackedQuest(world, FLOOR1_SHOP_QUEST_ID);
      render();
    },
  };

  gui.add(actions, 'killRat').name('Kill a rat');
  gui.add(actions, 'killSlime').name('Kill a slime');
  gui.add(actions, 'reachLevel2').name('Complete level-2 quest');
  gui.add(actions, 'meetMerchant').name('Talk to merchant');
  gui.add(actions, 'pickUpRatTail').name('Pick up rat tail');
  gui.add(actions, 'returnPrize').name('Return prize');
  gui.add(actions, 'addGold').name(`Add ${SHOPKEEPER_EQUIPMENT_COST} gold`);
  gui.add(actions, 'buyEquipment').name('Buy equipment');
  gui.add(actions, 'equipGear').name('Equip gear');
  gui.add(actions, 'trackTutorial').name('Track: tutorial');
  gui.add(actions, 'trackShop').name('Track: shop');

  tick();

  const hint = document.createElement('p');
  hint.textContent =
    'Quest system sandbox — drive the Floor 1 tutorial + shopkeeper errand and watch the tracker, multistep reveal, and feature unlocks update.';
  hint.style.cssText =
    'padding:8px 16px;color:#fbcfe8;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('quest-lab', {
  category: 'Progression' as LabCategory,
  name: 'Quest Lab',
  description:
    'Drive the data-driven quest log: tutorial kill counters, the multistep shopkeeper errand, and inventory/equipment feature unlocks.',
  create: createQuestLab,
});
