import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { MainGameScene } from '../../engine/scenes/MainGameScene.js';
import {
  enemyAISystem,
  floor1EnemyDirectorSystem,
  floor1ObjectiveSystem,
  floor1PlayerStatSystem,
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
  weaponSystem,
} from '../../game/index.js';
import { abilitySystem, levelSystem, skillSystem, statsSystem } from '../../game/systems/index.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface Floor1LabSettings {
  autoPickStarter: boolean;
  starterChoice: number;
}

interface SubsystemStatus {
  name: string;
  hook: 'Loop pre hook' | 'Loop post hook' | 'Not wired';
  implementation: 'Real game implementation' | 'Lab-only wiring';
  activeInFloor1: boolean;
  note?: string;
}

const LAB_ID = 'floor1-lab';

const FLOOR1_SUBSYSTEM_STATUS: readonly SubsystemStatus[] = [
  {
    name: 'statsSystem',
    hook: 'Loop pre hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
  },
  {
    name: 'floor1PlayerStatSystem',
    hook: 'Loop pre hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
  },
  {
    name: 'weaponSystem',
    hook: 'Loop pre hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
  },
  {
    name: 'enemyAISystem',
    hook: 'Loop pre hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
    note: 'Runs inside the main fixed-step game loop via the pre-system hook.',
  },
  {
    name: 'floor1EnemyDirectorSystem',
    hook: 'Loop pre hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
  },
  {
    name: 'levelSystem',
    hook: 'Loop post hook',
    implementation: 'Real game implementation',
    activeInFloor1: false,
    note: 'Wired, but currently inactive for this Floor 1 slice.',
  },
  {
    name: 'skillSystem',
    hook: 'Loop post hook',
    implementation: 'Real game implementation',
    activeInFloor1: false,
    note: 'Wired, but currently inactive for this Floor 1 slice.',
  },
  {
    name: 'abilitySystem',
    hook: 'Loop post hook',
    implementation: 'Real game implementation',
    activeInFloor1: false,
    note: 'Wired, but currently inactive for this Floor 1 slice.',
  },
  {
    name: 'floor1ObjectiveSystem',
    hook: 'Loop post hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
  },
  {
    name: 'enemySpawnerSystem',
    hook: 'Not wired',
    implementation: 'Real game implementation',
    activeInFloor1: false,
    note: 'Not used by Floor 1; replaced by floor1EnemyDirectorSystem.',
  },
  {
    name: 'weaponEntitySystem',
    hook: 'Not wired',
    implementation: 'Real game implementation',
    activeInFloor1: false,
  },
];

function createFloor1Lab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: Floor1LabSettings = {
    autoPickStarter: false,
    starterChoice: 1,
    ...(loadLabState<Floor1LabSettings>(LAB_ID) ?? {}),
  };

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';
  root.append(gameHost);

  const hint = document.createElement('p');
  hint.textContent =
    'Floor 1 vertical-slice lab. Toggle auto-pick to skip loadout and jump straight into the tutorial loop.';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.append(hint);

  const hookNote = document.createElement('p');
  hookNote.textContent =
    'Pre/Post are hook positions in MainGameScene fixed-step loop. They are not separate loops.';
  hookNote.style.marginTop = '8px';
  hookNote.style.color = '#9fb0d8';
  hookNote.style.lineHeight = '1.5';
  controls.append(hookNote);

  const subsystemTitle = document.createElement('h3');
  subsystemTitle.textContent = 'Game subsystem status (Floor 1 lab)';
  subsystemTitle.style.margin = '16px 0 8px';
  subsystemTitle.style.color = '#e5edff';
  subsystemTitle.style.fontSize = '14px';
  controls.append(subsystemTitle);

  const subsystemTable = document.createElement('table');
  subsystemTable.style.width = '100%';
  subsystemTable.style.borderCollapse = 'collapse';
  subsystemTable.style.fontSize = '12px';
  subsystemTable.style.color = '#c9d4ff';
  subsystemTable.innerHTML = `
    <thead>
      <tr>
        <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2a3758;">Subsystem</th>
        <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2a3758;">Hook</th>
        <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2a3758;">Implementation</th>
        <th style="text-align:left;padding:4px 6px;border-bottom:1px solid #2a3758;">Active in Floor 1</th>
      </tr>
    </thead>
    <tbody>
      ${FLOOR1_SUBSYSTEM_STATUS.map(
        (entry) => `<tr>
          <td style="padding:4px 6px;border-bottom:1px solid #1a2338;">${entry.name}</td>
          <td style="padding:4px 6px;border-bottom:1px solid #1a2338;">${entry.hook}</td>
          <td style="padding:4px 6px;border-bottom:1px solid #1a2338;">${entry.implementation}</td>
          <td style="padding:4px 6px;border-bottom:1px solid #1a2338;">${entry.activeInFloor1 ? 'Yes' : 'No'}</td>
        </tr>`,
      ).join('')}
    </tbody>
  `;
  controls.append(subsystemTable);

  const subsystemNotes = document.createElement('ul');
  subsystemNotes.style.margin = '8px 0 0';
  subsystemNotes.style.paddingLeft = '18px';
  subsystemNotes.style.color = '#9fb0d8';
  subsystemNotes.style.fontSize = '12px';
  subsystemNotes.style.lineHeight = '1.5';
  for (const entry of FLOOR1_SUBSYSTEM_STATUS) {
    if (!entry.note) {
      continue;
    }
    const note = document.createElement('li');
    note.textContent = `${entry.name}: ${entry.note}`;
    subsystemNotes.append(note);
  }
  controls.append(subsystemNotes);

  let game: Phaser.Game | undefined;

  const createGame = (): void => {
    game?.destroy(true);
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: gameHost,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#05070f',
      scene: [
        new MainGameScene({
          configureWorld: (world, playerEid) => {
            initializeFloor1Scenario(world, playerEid);
            if (settings.autoPickStarter) {
              const clamped = Math.max(1, Math.min(3, Math.floor(settings.starterChoice)));
              selectFloor1StarterWeapon(world, clamped - 1);
            }
          },
          selectLoadoutOption: selectFloor1StarterWeapon,
          preSystems: [
            statsSystem,
            floor1PlayerStatSystem,
            weaponSystem,
            enemyAISystem,
            floor1EnemyDirectorSystem,
          ],
          postSystems: [levelSystem, skillSystem, abilitySystem, floor1ObjectiveSystem],
        }),
      ],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  gui
    .add(settings, 'autoPickStarter')
    .name('Auto-pick loadout')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      createGame();
    });
  gui
    .add(settings, 'starterChoice', 1, 3, 1)
    .name('Auto choice (1-3)')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      if (settings.autoPickStarter) {
        createGame();
      }
    });
  gui
    .add(
      {
        restart: () => createGame(),
      },
      'restart',
    )
    .name('Restart');

  createGame();

  return () => {
    game?.destroy(true);
    hint.remove();
    hookNote.remove();
    subsystemTitle.remove();
    subsystemTable.remove();
    subsystemNotes.remove();
    root.remove();
  };
}

registerLab('floor1-lab', {
  category: 'Progression' as LabCategory,
  name: 'Floor 1 Tutorial Lab',
  description:
    'End-to-end sandbox for the Floor 1 starter loadout, objectives, and staircase timer.',
  create: createFloor1Lab,
});
