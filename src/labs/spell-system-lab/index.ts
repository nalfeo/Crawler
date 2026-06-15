import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import {
  acceptQuest,
  getActiveQuests,
  getQuestObjectiveViews,
  questSystem,
} from '../../core/systems/questSystem.js';
import { FLOOR1_BOSS_BATTLE_QUEST_ID, getQuestDef } from '../../shared/quest-types.js';
import { initializeFloor1Scenario, selectSpellFromBossBattle } from '../../game/floor1Scenario.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface SpellLabSettings {
  spellSelection: 'none' | 'fireball' | 'heal' | 'pulse-shield';
}

function createSpellSystemLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const LAB_SEED = 4242;

  const world: GameWorld = createGameWorld({ seed: LAB_SEED });
  world.state = 'playing';
  const playerEid = spawnPlayer(world, 0, 0);
  initializeBaseStats(world, playerEid);
  initializeFloor1Scenario(world, playerEid);

  const settings: SpellLabSettings = {
    spellSelection: 'none',
  };

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;line-height:1.5;overflow:auto;max-height:560px;';
  canvasHost.append(panel);

  function tick(): void {
    questSystem(world);
    render();
  }

  function render(): void {
    const lines: string[] = [];

    // Feature unlocks status
    lines.push(`<b>Feature unlocks:</b>`);
    lines.push(`&nbsp;&nbsp;spells: ${world.featureUnlocks.spells}`);
    lines.push(`&nbsp;&nbsp;inventory: ${world.featureUnlocks.inventory}`);
    lines.push(`&nbsp;&nbsp;equipment: ${world.featureUnlocks.equipment}`);
    lines.push('');

    // Goal flags status
    lines.push(`<b>Goal flags:</b>`);
    lines.push(
      `&nbsp;&nbsp;floor1-boss-battle-complete: ${world.goalFlags.get('floor1-boss-battle-complete') ?? false}`,
    );
    lines.push('');

    // Player spell state
    const abilityState = world.abilityStatesByEntity.get(playerEid);
    lines.push(`<b>Player spells:</b>`);
    if (abilityState && abilityState.equippedActiveAbilityIds.length > 0) {
      for (const spell of abilityState.equippedActiveAbilityIds) {
        lines.push(`&nbsp;&nbsp;- ${spell}`);
      }
    } else {
      lines.push(`&nbsp;&nbsp;(none)`);
    }
    lines.push('');

    // Mana status
    lines.push(`<b>Mana:</b>`);
    lines.push(`&nbsp;&nbsp;playerMp: ${world.playerMp}`);
    lines.push(`&nbsp;&nbsp;playerMaxMp: ${world.playerMaxMp}`);
    lines.push('');

    // Quest status
    lines.push(`<b>Quests:</b>`);
    for (const quest of getActiveQuests(world)) {
      const def = getQuestDef(quest.questId);
      lines.push(`&nbsp;&nbsp;<b>${def?.title ?? quest.questId}</b> [${quest.status}]`);
      for (const view of getQuestObjectiveViews(world, quest, playerEid)) {
        if (view.hidden) {
          continue;
        }
        const box = view.complete ? '☑' : '☐';
        const count =
          view.target > 1 ? ` (${Math.min(view.current, view.target)}/${view.target})` : '';
        lines.push(`&nbsp;&nbsp;&nbsp;&nbsp;${box} ${view.def.label}${count}`);
      }
    }

    panel.innerHTML = lines.join('<br/>');
  }

  const actions = {
    acceptBossQuest: () => {
      acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);
      tick();
    },
    completeBossBattle: () => {
      world.goalFlags.set('floor1-boss-battle-complete', true);
      tick();
    },
    selectFireball: () => {
      const result = selectSpellFromBossBattle(world, playerEid, 'fireball');
      if (result) {
        settings.spellSelection = 'fireball';
      }
      tick();
    },
    selectHeal: () => {
      const result = selectSpellFromBossBattle(world, playerEid, 'heal');
      if (result) {
        settings.spellSelection = 'heal';
      }
      tick();
    },
    selectPulseShield: () => {
      const result = selectSpellFromBossBattle(world, playerEid, 'pulse-shield');
      if (result) {
        settings.spellSelection = 'pulse-shield';
      }
      tick();
    },
    reset: () => {
      location.reload();
    },
  };

  gui.add(actions, 'acceptBossQuest').name('Accept boss quest');
  gui.add(actions, 'completeBossBattle').name('Simulate boss defeat');
  gui.add(actions, 'selectFireball').name('Select: Fireball');
  gui.add(actions, 'selectHeal').name('Select: Heal');
  gui.add(actions, 'selectPulseShield').name('Select: Pulse Shield');
  gui.add(actions, 'reset').name('Reset');

  tick();

  const hint = document.createElement('p');
  hint.textContent =
    'Spell system sandbox — accept the boss quest, simulate boss defeat, and select a spell to unlock the ability system.';
  hint.style.cssText =
    'padding:8px 16px;color:#fbcfe8;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('spell-system-lab', {
  category: 'Progression' as LabCategory,
  name: 'Spell System Lab',
  description:
    'Test the Floor 1 boss quest spell reward system: accept the boss quest, simulate battle completion, and select a spell to unlock spells feature.',
  create: createSpellSystemLab,
});
