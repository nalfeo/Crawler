import GUI from 'lil-gui';
import { query } from 'bitecs';
import Phaser from 'phaser';
import { Player } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { GAME } from '../../shared/constants.js';
import { BootScene, MainGameScene } from '../../engine/index.js';
import {
  acceptQuest,
  enemyAISystem,
  floor1EnemyDirectorSystem,
  floorObjectiveSystem,
  floor1PlayerStatSystem,
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
  startFloor1BossEncounter,
  questSystem,
  setTrackedQuest,
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
import {
  confirmFloor1StairDescend,
  meetSpellQuestGiver,
  selectSpellFromBossBattle,
} from '../../game/floor1Scenario.js';
import { setGoalFlag } from '../../core/door-lock.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_BOSS_UNLOCK_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
  FLOOR1_TUTORIAL_QUEST_ID,
  getQuestDef,
  objectiveTarget,
} from '../../shared/quest-types.js';
import { MERCHANTS_CHARM_DEF } from '../../shared/equipmentDefs.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface Floor1LabSettings {
  autoPickStarter: boolean;
  starterChoice: number;
  jumpTarget: JumpTarget;
}

type JumpTarget =
  | 'spawn-room'
  | 'welcome-office'
  | 'slime-rat-room'
  | 'quest-item-room'
  | 'staircase-room'
  | 'spell-quest-giver'
  | 'shopkeeper'
  | 'boss-encounter';

interface SubsystemStatus {
  name: string;
  hook: 'Loop pre hook' | 'Loop post hook' | 'Not wired';
  implementation: 'Real game implementation' | 'Lab-only wiring';
  activeInFloor1: boolean;
  note?: string;
}

const LAB_ID = 'floor1-lab';
const JUMP_TARGET_LABELS: Record<JumpTarget, string> = {
  'spawn-room': 'Spawn room',
  'welcome-office': 'Welcome office',
  'slime-rat-room': 'Slime Rat room',
  'quest-item-room': 'Quest item room',
  'staircase-room': 'Staircase/boss room',
  'spell-quest-giver': 'Spell quest giver NPC',
  shopkeeper: 'Shopkeeper NPC',
  'boss-encounter': 'Boss encounter (force)',
};
const JUMP_TARGET_PRIORITY: Record<Exclude<JumpTarget, 'boss-encounter'>, number> = {
  'spawn-room': 1,
  'welcome-office': 1,
  'slime-rat-room': 1,
  'quest-item-room': 1,
  'staircase-room': 1,
  'spell-quest-giver': 2,
  shopkeeper: 2,
};
const JUMP_TARGET_ORDER: readonly Exclude<JumpTarget, 'boss-encounter'>[] = [
  'spell-quest-giver',
  'shopkeeper',
  'spawn-room',
  'welcome-office',
  'slime-rat-room',
  'quest-item-room',
  'staircase-room',
];

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
  // - ?boss=1 starts at boss encounter (legacy quick-start)
  // e.g. http://localhost:3004/lab.html?lab=floor1-lab&boss=1
  const urlParams = new URLSearchParams(window.location.search);
  const urlAutoPick = urlParams.get('autopick') === '1';
  const urlWeapon = parseInt(urlParams.get('weapon') ?? '0', 10);
  const urlBoss = urlParams.get('boss') === '1';

  const settings: Floor1LabSettings = {
    autoPickStarter: urlAutoPick,
    starterChoice: urlWeapon >= 1 && urlWeapon <= 3 ? urlWeapon : 1,
    jumpTarget: 'spawn-room',
    ...(loadLabState<Floor1LabSettings>(LAB_ID) ?? {}),
    // URL params always override persisted state
    ...(urlAutoPick ? { autoPickStarter: true } : {}),
    ...(urlWeapon >= 1 && urlWeapon <= 3 ? { starterChoice: urlWeapon } : {}),
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
  let currentWorld: GameWorld | undefined;
  let currentPlayerEid: number | undefined;

  const QUEST_DEBUG_TARGETS = {
    'Tutorial: floor1-tutorial': FLOOR1_TUTORIAL_QUEST_ID,
    'Boss unlock: floor1-boss-unlock': FLOOR1_BOSS_UNLOCK_QUEST_ID,
    'Boss battle: floor1-boss-battle': FLOOR1_BOSS_BATTLE_QUEST_ID,
    'Shopkeeper errand: floor1-shopkeeper-errand': FLOOR1_SHOP_QUEST_ID,
  } as const;
  const QUEST_DEBUG_ACTIONS = {
    'Accept / enable quest': 'accept',
    'Complete quest now': 'complete',
  } as const;
  const questDebug = {
    questId: FLOOR1_TUTORIAL_QUEST_ID,
    action: 'accept',
    apply: () => {
      if (!currentWorld) {
        return;
      }
      const questId = questDebug.questId;
      const quest = acceptQuest(currentWorld, questId);
      if (!quest) {
        return;
      }
      setTrackedQuest(currentWorld, questId);
      if (questDebug.action === 'complete') {
        const def = getQuestDef(questId);
        if (def) {
          for (const objective of def.objectives) {
            quest.progress[objective.id] = objectiveTarget(objective);
            quest.done[objective.id] = true;
            if (objective.kind === 'goal' && objective.goalId) {
              setGoalFlag(currentWorld, objective.goalId, true);
            }
          }
          if (def.onCompleteGoalFlag) {
            setGoalFlag(currentWorld, def.onCompleteGoalFlag, true);
          }
          questSystem(currentWorld);
        }
      }
    },
  };

  const getPlayerEid = (): number | undefined => {
    if (!currentWorld) {
      return undefined;
    }
    if (currentPlayerEid !== undefined && currentPlayerEid >= 0) {
      return currentPlayerEid;
    }
    return query(currentWorld.ecs, [Player])[0];
  };

  const movePlayerTo = (x: number, y: number): boolean => {
    const world = currentWorld;
    const playerEid = getPlayerEid();
    if (!world || playerEid === undefined) {
      return false;
    }
    world.stores.position.x[playerEid] = x;
    world.stores.position.y[playerEid] = y;
    world.stores.velocity.x[playerEid] = 0;
    world.stores.velocity.y[playerEid] = 0;
    return true;
  };

  const resolveJumpPosition = (
    world: NonNullable<typeof currentWorld>,
    target: Exclude<JumpTarget, 'boss-encounter'>,
  ): { x: number; y: number } | null => {
    const objective = world.floor1?.objective;
    if (!objective) {
      return null;
    }
    switch (target) {
      case 'spawn-room': {
        const spawnTile = world.floorMap?.playerSpawn;
        if (spawnTile && world.floorMap) {
          return world.floorMap.tileToPixel(spawnTile.x, spawnTile.y);
        }
        return null;
      }
      case 'welcome-office':
        return objective.welcomeOfficePos;
      case 'slime-rat-room':
        return objective.slimeRatRoomPos;
      case 'quest-item-room':
        return objective.questItemPos;
      case 'staircase-room':
        return objective.staircasePos;
      case 'spell-quest-giver': {
        const eid = world.floor1?.spellQuestGiverNpcEid;
        if (eid === null || eid === undefined) {
          return objective.spellQuestGiverPos;
        }
        return {
          x: world.stores.position.x[eid] ?? objective.spellQuestGiverPos.x,
          y: world.stores.position.y[eid] ?? objective.spellQuestGiverPos.y,
        };
      }
      case 'shopkeeper': {
        const eid = world.floor1?.shopkeeperNpcEid;
        if (eid === null || eid === undefined) {
          return objective.shopRoomPos;
        }
        return {
          x: world.stores.position.x[eid] ?? objective.shopRoomPos.x,
          y: world.stores.position.y[eid] ?? objective.shopRoomPos.y,
        };
      }
    }
  };

  const computeJumpTargetOptions = (): Record<string, JumpTarget> => {
    if (!currentWorld) {
      return {
        [JUMP_TARGET_LABELS['spell-quest-giver']]: 'spell-quest-giver',
        [JUMP_TARGET_LABELS.shopkeeper]: 'shopkeeper',
        [JUMP_TARGET_LABELS['spawn-room']]: 'spawn-room',
        [JUMP_TARGET_LABELS['welcome-office']]: 'welcome-office',
        [JUMP_TARGET_LABELS['slime-rat-room']]: 'slime-rat-room',
        [JUMP_TARGET_LABELS['quest-item-room']]: 'quest-item-room',
        [JUMP_TARGET_LABELS['staircase-room']]: 'staircase-room',
        [JUMP_TARGET_LABELS['boss-encounter']]: 'boss-encounter',
      };
    }
    const chosenByCoord = new Map<string, Exclude<JumpTarget, 'boss-encounter'>>();
    for (const target of JUMP_TARGET_ORDER) {
      const pos = resolveJumpPosition(currentWorld, target);
      if (!pos) {
        continue;
      }
      const key = `${Math.round(pos.x)}:${Math.round(pos.y)}`;
      const prior = chosenByCoord.get(key);
      if (!prior || JUMP_TARGET_PRIORITY[target] > JUMP_TARGET_PRIORITY[prior]) {
        chosenByCoord.set(key, target);
      }
    }

    const keep = new Set(chosenByCoord.values());
    const options: Record<string, JumpTarget> = {};
    for (const target of JUMP_TARGET_ORDER) {
      if (keep.has(target)) {
        options[JUMP_TARGET_LABELS[target]] = target;
      }
    }
    options[JUMP_TARGET_LABELS['boss-encounter']] = 'boss-encounter';
    return options;
  };

  let jumpTargetController: ReturnType<GUI['add']> | undefined;
  const refreshJumpTargetController = (): void => {
    const options = computeJumpTargetOptions();
    const values = Object.values(options);
    if (values.length === 0) {
      return;
    }
    if (!values.includes(settings.jumpTarget)) {
      settings.jumpTarget = values[0]!;
    }
    if (!jumpTargetController) {
      jumpTargetController = gui
        .add(settings, 'jumpTarget', options)
        .name('Jump target')
        .onChange(() => {
          saveLabState(LAB_ID, settings);
        });
      return;
    }
    jumpTargetController.options(options);
    jumpTargetController.updateDisplay();
  };

  const jumpToTarget = (target: JumpTarget): void => {
    const world = currentWorld;
    const playerEid = getPlayerEid();
    if (!world || playerEid === undefined) {
      return;
    }
    if (target === 'boss-encounter') {
      startFloor1BossEncounter(world, playerEid);
      return;
    }
    const pos = resolveJumpPosition(world, target);
    if (!pos) {
      return;
    }
    movePlayerTo(pos.x, pos.y);
  };

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
            currentWorld = world;
            currentPlayerEid = playerEid;
            initializeFloor1Scenario(world, playerEid);
            if (settings.autoPickStarter || urlBoss) {
              const clamped = Math.max(1, Math.min(3, Math.floor(settings.starterChoice)));
              selectFloor1StarterWeapon(world, clamped - 1);
            }
            if (urlBoss) {
              startFloor1BossEncounter(world, playerEid);
            }
            refreshJumpTargetController();
          },
          selectLoadoutOption: selectFloor1StarterWeapon,
          onStairDescend: confirmFloor1StairDescend,
          selectSpellFromBossBattle: (world, playerEid, spellId) => {
            selectSpellFromBossBattle(world, playerEid, spellId);
          },
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
          spellQuestGiver: { meet: meetSpellQuestGiver },
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
  refreshJumpTargetController();
  gui
    .add(
      {
        jumpNow: () => jumpToTarget(settings.jumpTarget),
      },
      'jumpNow',
    )
    .name('Jump now');
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
  debugFolder.add(questDebug, 'questId', QUEST_DEBUG_TARGETS).name('Quest target');
  debugFolder.add(questDebug, 'action', QUEST_DEBUG_ACTIONS).name('Quest action');
  debugFolder.add(questDebug, 'apply').name('Apply quest debug');

  createGame();

  return () => {
    game?.destroy(true);
    currentWorld = undefined;
    currentPlayerEid = undefined;
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
