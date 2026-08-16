/**
 * Reward Opening UX Lab — Phaser sandbox for the deterministic
 * anticipation -> reveal -> summary -> claimed sequence
 * (`createRewardOpeningUI`) wired up exactly like `MainGameScene`: a real
 * `AchievementsUI` sharing one `RewardOpeningUI` instance.
 *
 * Boss chests now drop in-world and auto-open via proximity; the panel
 * toggle path (`BossChestUI`) has been removed. The "Defeat boss → open
 * chest" button in the Boss chest folder goes straight to `openBossChest`
 * and then starts the reveal presentation, exercising the same
 * reward path the real game uses after proximity pickup.
 *
 * A "Simulate reload" button demonstrates save/load-safe presentation: it
 * tears down and recreates the Phaser UI against the SAME `GameWorld`
 * (which still holds any unacknowledged `pendingPresentations`/
 * `revealedGrant`), then the scene's `create()` calls
 * `resumePendingPresentation` on the achievements panel — exactly what
 * `MainGameScene.create()` does after `configureWorld` restores a save. The
 * world (and its player entity) is created ONCE per "Reset" click and reused
 * across every "Simulate reload".
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { createGameWorld, spawnPlayer, type GameWorld } from '../../core/index.js';
import { unlockAchievement } from '../../game/systems/achievementSystem.js';
import { spawnBossChestForDefeatedBoss } from '../../game/boss-chest-resolver.js';
import { openBossChest, createBossChestId } from '../../core/systems/bossChestRewards.js';
import { generatedEquipmentRunKeyFromSeed } from '../../shared/generated-equipment-types.js';
import { createRewardOpeningUI, type RewardOpeningUI } from '../../engine/RewardOpeningUI.js';
import { createAchievementsUI } from '../../engine/AchievementsUI.js';
import { createLogger } from '../../shared/logger.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'reward-opening-ux-lab';
const SCENE_KEY = 'RewardOpeningUxLabScene';
const LAB_SEED = 4242;
const BOSS_FAMILY_ID = 'lab-reward-boss';
const logger = createLogger('labs:reward-opening-ux');

/** Achievement ids spanning the excitement spectrum for quick comparison. */
const LOOTBOX_TRASH_ACHIEVEMENT = 'first-bonk'; // lootBox / trash -> "modest"
const LOOTBOX_RARE_ACHIEVEMENT = 'room-sweeper'; // lootBox / rare -> more "exciting"
const EQUIPMENT_TIER1_ACHIEVEMENT = 'floor2-field-kit'; // equipment / tier1
const EQUIPMENT_TIER2_ACHIEVEMENT = 'floor2-second-wind'; // equipment / tier2
const EQUIPMENT_TIER3_ACHIEVEMENT = 'floor2-veteran-cast'; // equipment / tier3

function createLabWorld(): GameWorld {
  const world = createGameWorld({
    seed: LAB_SEED,
    floor: 2,
    entityCapacityMode: 'lab',
    generatedEquipmentRunKey: generatedEquipmentRunKeyFromSeed(LAB_SEED),
  });
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentRewards = true;
  // Boss chests gate on the separate "economy" flag (Quartermaster + boss
  // chests), distinct from the achievement-reward-resolution flag above.
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
  return world;
}

function createRewardOpeningUxLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  canvasHost.append(root);

  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'width:100%;height:100%;';
  root.append(gameHost);

  const status = document.createElement('pre');
  status.style.cssText =
    'margin-top:16px;color:#c9d4ff;line-height:1.6;font-size:12px;white-space:pre-wrap;';
  controls.append(status);

  const hint = document.createElement('p');
  hint.textContent =
    'Unlock a reward below, then use [V] Achievements / [C] Boss Chests to browse and ' +
    "open it. Unlock two or more loot-box achievements to see the summary screen's " +
    '"Open next" chain button ([N]), which opens boxes back to back. Reduced motion follows your OS "prefers-reduced-motion" setting — this lab ' +
    'has no separate in-game toggle by design (see reduced-motion.ts).';
  hint.style.cssText = 'margin-top:8px;color:#9ca3af;line-height:1.5;font-size:11px;';
  controls.append(hint);

  let game: Phaser.Game | undefined;
  let world: GameWorld = createLabWorld();
  // Persisted across "Simulate reload" (which recreates the Phaser game/scene
  // against the SAME world) — a real save/load resume never re-spawns the
  // player, so neither does this lab.
  let playerEid = -1;
  let rewardOpeningUI: RewardOpeningUI | undefined;
  let achievementsUI: ReturnType<typeof createAchievementsUI> | undefined;

  function renderStatus(): void {
    const phase = rewardOpeningUI?.getPhase() ?? null;
    const bucket = rewardOpeningUI?.getBucket() ?? null;
    const progress = rewardOpeningUI?.getRevealProgress() ?? null;
    const lines = [
      `world: seed=${LAB_SEED} floor=${world.floor}`,
      `achievements unlocked: ${world.achievements.unlockedIds.size} · claimed: ${world.achievements.claimedIds.size}`,
      `pending achievement presentations: ${world.achievements.pendingPresentations.size}`,
      `boss chests: ${world.bossChests.size}`,
      `rewardOpeningUI: open=${rewardOpeningUI?.isOpen() ?? false} phase=${phase ?? '—'} bucket=${bucket ?? '—'}` +
        (progress ? ` reveal=${progress.revealed}/${progress.total}` : ''),
      `next box on summary: ${rewardOpeningUI?.getNextRewardLabel() ?? '—'}`,
    ];
    status.textContent = lines.join('\n');
  }

  class RewardOpeningUxLabScene extends Phaser.Scene {
    constructor() {
      super({ key: SCENE_KEY });
    }

    create(): void {
      if (playerEid < 0) {
        playerEid = spawnPlayer(world, 0, 0);
      }

      this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);
      this.add
        .text(GAME.WIDTH / 2, 40, 'Reward Opening UX Lab — [V] Achievements', {
          fontFamily: 'monospace',
          fontSize: '16px',
          color: '#4b5563',
        })
        .setOrigin(0.5, 0.5);

      rewardOpeningUI = createRewardOpeningUI(this, {});
      achievementsUI = createAchievementsUI(this, rewardOpeningUI);

      // Mirrors MainGameScene.create(): resume any reveal left unacknowledged
      // by a prior game/scene instance against this same world.
      achievementsUI.resumePendingPresentation(world);

      const keyV = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.V);
      this.events.on('update', (_time: number, delta: number) => {
        if (rewardOpeningUI?.isOpen()) {
          rewardOpeningUI.tick(delta);
        }
        if (keyV && Phaser.Input.Keyboard.JustDown(keyV) && !rewardOpeningUI?.isOpen()) {
          achievementsUI?.toggle(world);
        }
        renderStatus();
      });

      this.events.once('shutdown', () => {
        rewardOpeningUI?.destroy();
        achievementsUI?.destroy();
        rewardOpeningUI = undefined;
        achievementsUI = undefined;
      });

      renderStatus();
    }
  }

  const createGame = (): void => {
    game?.destroy(true);
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: gameHost,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#05070f',
      scene: [RewardOpeningUxLabScene],
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    };
    game = new Phaser.Game(config);
  };

  function unlock(id: string): void {
    const ok = unlockAchievement(world, id);
    logger.info('Lab unlockAchievement', { id, ok });
    renderStatus();
  }

  const unlockFolder = gui.addFolder('Unlock achievement reward');
  unlockFolder
    .add({ run: () => unlock(LOOTBOX_TRASH_ACHIEVEMENT) }, 'run')
    .name('lootBox · trash ("modest")');
  unlockFolder
    .add({ run: () => unlock(LOOTBOX_RARE_ACHIEVEMENT) }, 'run')
    .name('lootBox · rare (more "exciting")');
  unlockFolder
    .add({ run: () => unlock(EQUIPMENT_TIER1_ACHIEVEMENT) }, 'run')
    .name('equipment · tier1');
  unlockFolder
    .add({ run: () => unlock(EQUIPMENT_TIER2_ACHIEVEMENT) }, 'run')
    .name('equipment · tier2');
  unlockFolder
    .add({ run: () => unlock(EQUIPMENT_TIER3_ACHIEVEMENT) }, 'run')
    .name('equipment · tier3');

  const bossFolder = gui.addFolder('Boss chest');
  bossFolder
    .add(
      {
        spawn: () => {
          const result = spawnBossChestForDefeatedBoss(world, BOSS_FAMILY_ID);
          logger.info('Lab spawnBossChestForDefeatedBoss', result);
          if (result.created && playerEid >= 0) {
            const chestId = createBossChestId(BOSS_FAMILY_ID);
            openBossChest(world, chestId, playerEid);
            logger.info('Lab openBossChest triggered (proximity simulation)');
          }
          renderStatus();
        },
      },
      'spawn',
    )
    .name('Defeat boss → spawn + open chest');

  const panelsFolder = gui.addFolder('Panels');
  panelsFolder
    .add({ toggle: () => achievementsUI?.toggle(world) }, 'toggle')
    .name('Toggle Achievements [V]');

  const sequenceFolder = gui.addFolder('Reveal sequence');
  sequenceFolder.add({ skip: () => rewardOpeningUI?.skip() }, 'skip').name('Skip to summary');
  sequenceFolder
    .add({ ack: () => rewardOpeningUI?.acknowledge() }, 'ack')
    .name('Acknowledge / close');
  sequenceFolder.add({ next: () => rewardOpeningUI?.openNext() }, 'next').name('Open next box [N]');

  gui
    .add(
      {
        reload: () => {
          // Tear down and recreate the presentation-layer UIs against the SAME
          // world — mirroring a save/load resume, where `configureWorld` has
          // already restored `pendingPresentations`/`revealedGrant` onto a
          // freshly created world before any UI exists.
          createGame();
        },
      },
      'reload',
    )
    .name('Simulate reload (resume pending)');

  gui
    .add(
      {
        reset: () => {
          world = createLabWorld();
          playerEid = -1;
          createGame();
        },
      },
      'reset',
    )
    .name('Reset (new world)');

  createGame();

  return () => {
    game?.destroy(true);
    status.remove();
    hint.remove();
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Progression' as LabCategory,
  name: 'Reward Opening UX Lab',
  description:
    'Real anticipation→reveal→summary→claimed sequence for achievement boxes and boss chests, driven through AchievementsUI/RewardOpeningUI. Boss chests now auto-open via proximity pickup; the lab simulates this by calling openBossChest directly. Exercises intensity scaling, skip, and save/load-safe resume.',
  create: createRewardOpeningUxLab,
});
