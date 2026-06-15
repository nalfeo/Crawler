import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { BootScene, MainGameScene } from '../../engine/index.js';
import {
  enemyAISystem,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  floor1PlayerStatSystem,
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
  startFloor1BossEncounter,
  questSystem,
  getShopkeeperStage,
  meetShopkeeper,
  returnShopkeeperPrize,
  purchaseShopkeeperEquipment,
  equipPurchasedGear,
  SHOPKEEPER_EQUIPMENT_COST,
  weaponSystem,
} from '../../game/index.js';
import { abilitySystem, levelSystem, skillSystem, statsSystem } from '../../game/systems/index.js';
import { npcSystem } from '../../core/index.js';
import { confirmFloor1StairDescend } from '../../game/floor1Scenario.js';
import { MERCHANTS_CHARM_DEF } from '../../shared/equipmentDefs.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface Floor1LabSettings {
  autoPickStarter: boolean;
  starterChoice: number;
  quickStartBossFight: boolean;
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
    name: 'npcSystem',
    hook: 'Loop pre hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
    note: 'Updates nearbyPlayer proximity flag for NPC dialogue interactions.',
  },
  {
    name: 'levelSystem',
    hook: 'Loop post hook',
    implementation: 'Real game implementation',
    activeInFloor1: true,
    note: 'Active; level-ups are driven by XP gems once the Tutorial Goon unlocks XP drops.',
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
    name: 'floorObjectiveSystem',
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

  // URL params:
  // - ?autopick=1 skips loadout modal
  // - ?weapon=1|2|3 selects auto-picked starter
  // - ?boss=1 teleports to boss room and immediately starts boss fight
  // e.g. http://localhost:3004/lab.html?lab=floor1-lab&boss=1
  const urlParams = new URLSearchParams(window.location.search);
  const urlAutoPick = urlParams.get('autopick') === '1';
  const urlWeapon = parseInt(urlParams.get('weapon') ?? '0', 10);
  const urlBoss = urlParams.get('boss') === '1';

  const settings: Floor1LabSettings = {
    autoPickStarter: urlAutoPick,
    starterChoice: urlWeapon >= 1 && urlWeapon <= 3 ? urlWeapon : 1,
    quickStartBossFight: urlBoss,
    ...(loadLabState<Floor1LabSettings>(LAB_ID) ?? {}),
    // URL params always override persisted state
    ...(urlAutoPick ? { autoPickStarter: true } : {}),
    ...(urlWeapon >= 1 && urlWeapon <= 3 ? { starterChoice: urlWeapon } : {}),
    ...(urlBoss ? { quickStartBossFight: true } : {}),
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
    'Floor 1 vertical-slice lab. Meet the Tutorial Goon to unlock XP drops + XP bar, reach level 2, then progress the boss unlock quest.';
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
      // Match the real game (src/main.ts): without these, Phaser defaults to
      // LINEAR filtering, which blurs the pixel-art tiles and samples the 1px
      // sheet spacing into dark grid seams — the "muddy" look. Each entry point
      // builds its own Phaser config, so this flag must be set per host.
      pixelArt: true,
      roundPixels: true,
      scene: [
        // BootScene preloads the Kenney sprite sheets, then starts
        // MainGameScene by key. Without it the tiny-dungeon textures never
        // load and MainGameScene falls back to procedural primitives — which
        // is why this slice previously rendered a flat-colored placeholder
        // instead of the real Floor 1 art.
        BootScene,
        new MainGameScene({
          configureWorld: (world, playerEid) => {
            initializeFloor1Scenario(world, playerEid);
            if (settings.autoPickStarter || settings.quickStartBossFight) {
              const clamped = Math.max(1, Math.min(3, Math.floor(settings.starterChoice)));
              selectFloor1StarterWeapon(world, clamped - 1);
            }
            if (settings.quickStartBossFight) {
              startFloor1BossEncounter(world, playerEid);
            }
          },
          selectLoadoutOption: selectFloor1StarterWeapon,
          onStairDescend: confirmFloor1StairDescend,
          shopkeeper: {
            getStage: getShopkeeperStage,
            meet: meetShopkeeper,
            returnPrize: returnShopkeeperPrize,
            purchase: purchaseShopkeeperEquipment,
            equip: equipPurchasedGear,
            equipmentCost: SHOPKEEPER_EQUIPMENT_COST,
            equipmentName: MERCHANTS_CHARM_DEF.name,
          },
          tutorialGoon: { meet: meetTutorialGoon },
          preSystems: [
            statsSystem,
            floor1PlayerStatSystem,
            weaponSystem,
            enemyAISystem,
            floor1EnemyDirectorSystem,
            npcSystem,
          ],
          postSystems: [levelSystem, skillSystem, abilitySystem, floorObjectiveSystem, questSystem],
        }),
      ],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
    // Debug helper: expose live game instance for browser-console inspection.
    (window as Window & { __floor1Game?: Phaser.Game }).__floor1Game = game;
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
    .add(settings, 'quickStartBossFight')
    .name('Quick boss start')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      createGame();
    });
  gui
    .add(
      {
        restart: () => createGame(),
      },
      'restart',
    )
    .name('Restart');

  const debugFolder = gui.addFolder('Debug');
  const debugState = { showAllRooms: false };
  debugFolder
    .add(debugState, 'showAllRooms')
    .name('Show all rooms (dim)')
    .onChange((v: boolean) => {
      const scene = game?.scene.getScene(MainGameScene.KEY) as MainGameScene | undefined;
      scene?.setDebugFlag('showAllRooms', v);
    });

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
