import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import {
  claimAchievementReward,
  isAchievementClaimed,
} from '../../core/systems/achievementRewards.js';
import { unlockAchievement } from '../../game/systems/achievementSystem.js';
import { ALL_ACHIEVEMENTS, type AchievementReward } from '../../shared/achievements.js';
import { generatedEquipmentRunKeyFromSeed } from '../../shared/generated-equipment-types.js';
import { registerLab, type LabCategory } from '../registry.js';

const LAB_SEED = 7;

// Both Floor 1's `floor1-materials` and Floor 2's `floor2-generated-equipment`
// `lootBox` reward tables resolve ONLY at unlock time and require a stable
// `generatedEquipmentRunKey` on the world's equipment registry — mirroring how
// every real entry point (MainGameScene, the headless runner) derives one from
// its world seed.
function createLabWorld(): GameWorld {
  const world = createGameWorld({
    seed: LAB_SEED,
    floor: 2,
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(LAB_SEED),
  });
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentRewards = true;
  // Claiming a reward (gold/materials/equipment) requires a Player entity
  // with an inventory bag — spawn one so every reward type can be opened.
  spawnPlayer(world, 0, 0);
  return world;
}

const DIFFICULTY_COLORS: Record<string, string> = {
  basic: '#9ca3af',
  standard: '#22c55e',
  hard: '#3b82f6',
  brutal: '#f59e0b',
};

function rewardText(reward: AchievementReward): string {
  switch (reward.type) {
    case 'lootBox':
      return reward.lootTable === 'floor2-generated-equipment'
        ? `${reward.tier} loot box`
        : `${reward.tier} box`;
    case 'item':
      return reward.itemId;
    case 'directorMessage':
      return 'message';
    case 'none':
      return 'no reward';
  }
}

function createAchievementsUiLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  let world: GameWorld = createLabWorld();

  const root = document.createElement('div');
  root.style.cssText =
    'padding:24px; height:100%; overflow:auto; color:#f8fafc; font-family:monospace;';
  canvasHost.append(root);

  function render(): void {
    root.innerHTML = '<h2 style="margin:0 0 12px">🏆 Achievements (safe-room panel)</h2>';
    const unlocked = ALL_ACHIEVEMENTS.filter((a) => world.achievements.unlockedIds.has(a.id));
    if (unlocked.length === 0) {
      const empty = document.createElement('p');
      empty.style.color = '#9ca3af';
      empty.textContent = 'No achievements unlocked yet — use the controls to unlock some.';
      root.append(empty);
      return;
    }
    for (const def of unlocked) {
      const claimed = isAchievementClaimed(world, def.id);
      const color = DIFFICULTY_COLORS[def.difficulty] ?? '#9ca3af';
      const row = document.createElement('div');
      row.style.cssText = `display:flex; justify-content:space-between; gap:16px; padding:10px 12px; margin-bottom:8px; border:1px solid ${color}; border-radius:8px; background:rgba(255,255,255,0.04);`;
      const left = document.createElement('div');
      left.innerHTML = `<div style="color:${color};font-weight:bold">${def.title}</div><div style="font-size:12px;color:#9ca3af">${def.unlockCriteria}</div><div style="font-size:11px;font-style:italic;color:#c9b8ff">${def.directorFlavor}</div>`;
      const btn = document.createElement('button');
      btn.textContent = claimed
        ? `Opened: ${rewardText(def.reward)}`
        : `Open: ${rewardText(def.reward)}`;
      btn.disabled = claimed;
      btn.style.cssText = `align-self:center; cursor:${claimed ? 'default' : 'pointer'}; color:${claimed ? '#22c55e' : '#fff'};`;
      btn.addEventListener('click', () => {
        claimAchievementReward(world, def.id);
        render();
      });
      row.append(left, btn);
      root.append(row);
    }
  }

  if (gui instanceof GUI) {
    const f = gui.addFolder('Unlock');
    f.add(
      {
        first: () => {
          unlockAchievement(world, 'first-bonk');
          render();
        },
      },
      'first',
    ).name('Unlock First Bonk');
    f.add(
      {
        all: () => {
          for (const a of ALL_ACHIEVEMENTS) unlockAchievement(world, a.id);
          render();
        },
      },
      'all',
    ).name('Unlock all');
    f.add(
      {
        reset: () => {
          world = createLabWorld();
          render();
        },
      },
      'reset',
    ).name('Reset');
  }

  render();
  return () => root.remove();
}

registerLab('achievements-ui-lab', {
  category: 'Progression' as LabCategory,
  name: 'Achievements UI Lab',
  description: 'Earned-achievements panel: title, unlock condition, Director flavor, open reward.',
  create: createAchievementsUiLab,
});
