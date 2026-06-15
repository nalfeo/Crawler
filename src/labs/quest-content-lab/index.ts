import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import {
  acceptQuest,
  addQuestCounter,
  getActiveQuests,
  getQuestObjectiveViews,
  questSystem,
} from '../../core/systems/questSystem.js';
import {
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  getAllQuestDefs,
  getQuestDef,
  getQuestPacks,
  installDefaultQuestPacks,
  installQuestPacks,
  questPackSchema,
} from '../../shared/quest-types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 777;

function installDynamicQuestPack(): void {
  installQuestPacks([
    ...getQuestPacks(),
    questPackSchema.parse({
      version: 1,
      packId: 'runtime-demo',
      quests: [
        {
          id: 'runtime-kill-demo',
          title: 'Runtime: Rat Audit',
          summary: 'Demonstrates template-driven quest injection at runtime.',
          template: {
            kind: 'killTargets',
            targets: [{ objectiveId: 'kill-rats-runtime', label: 'Audit 5 rats', target: 5 }],
          },
        },
      ],
    }),
  ]);
}

function createQuestContentLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const world: GameWorld = createGameWorld({ seed: LAB_SEED });
  world.state = 'playing';
  const playerEid = spawnPlayer(world, 0, 0);
  acceptQuest(world, FLOOR1_BOSS_UNLOCK_QUEST_ID);

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;line-height:1.45;overflow:auto;max-height:560px;';
  canvasHost.append(panel);

  function tick(): void {
    questSystem(world);
    render();
  }

  function render(): void {
    const lines: string[] = [];
    lines.push('<b>Quest packs</b>');
    for (const pack of getQuestPacks()) {
      lines.push(`• ${pack.packId} (v${pack.version}, quests=${pack.quests.length})`);
    }
    lines.push('');
    lines.push('<b>Registered quests</b>');
    for (const quest of getAllQuestDefs()) {
      lines.push(`• ${quest.id} — ${quest.title}`);
    }
    lines.push('');
    lines.push(`<b>Queued events:</b> ${world.questEvents.length}`);
    lines.push('');

    for (const quest of getActiveQuests(world)) {
      const def = getQuestDef(quest.questId);
      lines.push(`◆ <b>${def?.title ?? quest.questId}</b> [${quest.status}]`);
      for (const view of getQuestObjectiveViews(world, quest, playerEid)) {
        if (view.hidden) {
          lines.push('&nbsp;&nbsp;<span style="color:#777">… hidden …</span>');
          continue;
        }
        const box = view.complete ? '☑' : '☐';
        const count =
          view.target > 1 ? ` (${Math.min(view.current, view.target)}/${view.target})` : '';
        lines.push(`&nbsp;&nbsp;${box} ${view.def.label}${count}`);
      }
      lines.push('');
    }
    panel.innerHTML = lines.join('<br/>');
  }

  const actions = {
    addBossRatKill: () => {
      addQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-rats', 1);
      tick();
    },
    addBossSlimeKill: () => {
      addQuestCounter(world, FLOOR1_BOSS_UNLOCK_QUEST_ID, 'kill-slimes', 1);
      tick();
    },
    installRuntimePack: () => {
      installDynamicQuestPack();
      render();
    },
    acceptRuntimeQuest: () => {
      acceptQuest(world, 'runtime-kill-demo');
      tick();
    },
    advanceRuntimeQuest: () => {
      addQuestCounter(world, 'runtime-kill-demo', 'kill-rats-runtime', 1);
      tick();
    },
    resetPacks: () => {
      installDefaultQuestPacks();
      render();
    },
  };

  gui.add(actions, 'addBossRatKill').name('Boss quest: +1 rat');
  gui.add(actions, 'addBossSlimeKill').name('Boss quest: +1 slime');
  gui.add(actions, 'installRuntimePack').name('Install runtime quest pack');
  gui.add(actions, 'acceptRuntimeQuest').name('Accept runtime quest');
  gui.add(actions, 'advanceRuntimeQuest').name('Runtime quest: +1 kill');
  gui.add(actions, 'resetPacks').name('Reset quest packs');

  tick();

  const hint = document.createElement('p');
  hint.textContent =
    'Quest content lab — validates config packs, template compilation, and event-driven progression without changing code.';
  hint.style.cssText =
    'padding:8px 16px;color:#bfdbfe;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    installDefaultQuestPacks();
    panel.remove();
    hint.remove();
  };
}

registerLab('quest-content-lab', {
  category: 'Progression' as LabCategory,
  name: 'Quest Content Lab',
  description:
    'Inspect quest packs/templates at runtime and drive event-based progression for active quests.',
  create: createQuestContentLab,
});
