import { addComponent, query, set, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { BroadcastScore, Enemy, Velocity } from '../../core/components.js';
import {
  collisionSystem,
  createGameWorld,
  damageSystem,
  healthSystem,
  manaSystem,
  movementSystem,
  playerInputSystem,
  projectileCleanupSystem,
  lifetimeSystem,
  areaDamageSystem,
  beamSystem,
  trapSystem,
  returningProjectileSystem,
  aoeOnImpactPreDamage,
  aoeOnImpactPostDamage,
  meleeSwingSystem,
  knockbackSystem,
  dropSystem,
  deathTimerSystem,
  spawnAnimSystem,
  spawnPlayer,
  statSystem,
  type GameWorld,
} from '../../core/index.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { createInputCapture } from '../../engine/InputCapture.js';
import { createPhaserBridge } from '../../engine/PhaserBridge.js';
import {
  abilitySystem,
  configureEnemySpawner,
  enemySpawnerSystem,
  equipActiveAbility,
  getAllAbilityDefinitions,
  grantPassiveAbility,
  memorizeSpell,
  queueAbilityTrigger,
  setActiveWeapon,
  skillSystem,
  statsSystem,
  unequipActiveAbility,
  weaponSystem,
  type AbilityDefinition,
} from '../../game/index.js';
import { GAME, PLAYER_SPEED } from '../../shared/constants.js';
import { ftToPx, pxToFt } from '../../shared/units.js';
import { createInputState, type InputState } from '../../shared/input.js';
import { WEAPON_DEFS } from '../../shared/weaponDefs.js';
import { registerLab, type LabCategory } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_ID = 'abilities-lab';
const WEAPON_IDS = [...WEAPON_DEFS.keys()];
const ABILITIES = getAllAbilityDefinitions();
const MAX_STEPS_PER_FRAME = 8;
const LAB_SEED = 8842;

interface AbilitiesLabSettings {
  playerSpeed: number;
  maxEnemies: number;
  spawnIntervalMs: number;
  enemyHp: number;
  enemySpeed: number;
  activeWeapon: string;
  invulnerable: boolean;
  infiniteMana: boolean;
}

/** Serializable snapshot that survives HMR / lab reloads. */
interface AbilitiesLabSnapshot {
  settings: AbilitiesLabSettings;
  equipped: Record<string, boolean>;
}

function abilityKindLabel(def: AbilityDefinition): string {
  switch (def.kind) {
    case 'spell':
      return 'Spell';
    case 'passive':
      return 'Passive';
    default:
      return 'Active';
  }
}

function createAbilitiesLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #1a2040 0%, #0c0e1a 45%, #050510 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '12px 14px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(10, 12, 30, 0.82)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Move with WASD / arrows. Equip abilities in the controls panel — they fire on their real triggers ' +
    '(cluster/low-HP) in the live combat engine. Spells spend MP; toggle Infinite Mana to spam them. ' +
    'Use "Take 60% HP" to trip Heal / Pulse Shield, or "Trigger hits→10" for skill-usage actives.';
  hint.style.marginTop = '16px';
  hint.style.color = '#a5b4fc';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  const saved = loadLabState<AbilitiesLabSnapshot>(LAB_ID);

  const settings: AbilitiesLabSettings = {
    playerSpeed: PLAYER_SPEED,
    maxEnemies: 30,
    spawnIntervalMs: 750,
    enemyHp: 30,
    enemySpeed: 0.15625,
    activeWeapon: 'pistol',
    invulnerable: true,
    infiniteMana: true,
    ...(saved?.settings ?? {}),
  };

  // Which abilities are equipped/granted. Defaults to all so every ability is observable.
  const equipped: Record<string, boolean> = {};
  for (const def of ABILITIES) {
    equipped[def.id] = saved?.equipped?.[def.id] ?? true;
  }

  let resetWorldFromGui = () => undefined;
  let damagePlayerFromGui = () => undefined;
  let triggerHitsFromGui = () => undefined;

  class AbilitiesLabScene extends Phaser.Scene {
    private accumulator = 0;

    private bridge?: ReturnType<typeof createPhaserBridge>;

    private inputCapture?: ReturnType<typeof createInputCapture>;

    private inputState!: InputState;

    private playerEid = -1;

    private world!: GameWorld;

    private castCounts = new Map<string, number>();

    constructor() {
      super({ key: 'AbilitiesLabScene' });
    }

    create(): void {
      resetWorldFromGui = () => {
        this.resetWorld();
      };
      damagePlayerFromGui = () => {
        this.damagePlayer();
      };
      triggerHitsFromGui = () => {
        this.triggerHits();
      };

      this.inputState = createInputState();
      this.inputCapture = createInputCapture(this, {
        getFollowOrigin: () =>
          this.playerEid < 0
            ? undefined
            : {
                x: ftToPx(this.world.stores.position.x[this.playerEid] ?? 0),
                y: ftToPx(this.world.stores.position.y[this.playerEid] ?? 0),
              },
      });
      this.accumulator = 0;

      this.cameras.main.setBackgroundColor('#0c0e1a');
      this.bridge = createPhaserBridge(this);
      this.resetWorld();

      const handleResize = () => this.applySpawnerBounds();
      this.scale.on('resize', handleResize);
      this.events.once('shutdown', () => {
        resetWorldFromGui = () => undefined;
        damagePlayerFromGui = () => undefined;
        triggerHitsFromGui = () => undefined;
        this.scale.off('resize', handleResize);
        this.inputCapture?.destroy();
        this.inputCapture = undefined;
        this.bridge?.destroy();
        this.bridge = undefined;
      });
    }

    update(_time: number, delta: number): void {
      if (!this.bridge || !this.inputCapture) {
        return;
      }

      if (this.world.state === 'playing') {
        this.inputCapture.poll(this.inputState);
        this.accumulator += delta;
        let steps = 0;

        while (
          this.accumulator >= GAME.DELTA_MS &&
          steps < MAX_STEPS_PER_FRAME &&
          this.world.state === 'playing'
        ) {
          this.world.frameCount += 1;
          this.world.elapsedMs += GAME.DELTA_MS;

          this.applySpawnerBounds();

          playerInputSystem(this.world, this.inputState);
          this.applyPlayerSpeedSetting();
          statsSystem(this.world);
          statSystem(this.world);
          manaSystem(this.world);
          this.applyInfiniteMana();
          enemySpawnerSystem(this.world, {
            maxEnemies: settings.maxEnemies,
            spawnIntervalMs: settings.spawnIntervalMs,
            enemyHp: settings.enemyHp,
            enemySpeed: settings.enemySpeed,
          });
          movementSystem(this.world);
          returningProjectileSystem(this.world);
          weaponSystem(this.world);

          const collision = collisionSystem(this.world);
          aoeOnImpactPreDamage(this.world);
          damageSystem(this.world, collision);
          aoeOnImpactPostDamage(this.world);
          areaDamageSystem(this.world, collision);
          meleeSwingSystem(this.world);
          knockbackSystem(this.world);
          beamSystem(this.world);
          trapSystem(this.world, collision);

          dropSystem(this.world);
          deathTimerSystem(this.world);
          spawnAnimSystem(this.world);
          healthSystem(this.world);
          this.applyInvulnerability();
          lifetimeSystem(this.world);
          projectileCleanupSystem(this.world);

          skillSystem(this.world);
          this.tallyCasts(() => abilitySystem(this.world));

          this.accumulator -= GAME.DELTA_MS;
          steps += 1;
        }

        if (this.accumulator > GAME.DELTA_MS * MAX_STEPS_PER_FRAME) {
          this.accumulator = GAME.DELTA_MS;
        }
      }

      const interpAlpha = Math.min(1, Math.max(0, this.accumulator / GAME.DELTA_MS));
      const renderElapsedMs = this.world.elapsedMs + this.accumulator;
      this.bridge.sync(this.world, renderElapsedMs, interpAlpha);
      this.updateHud();
    }

    /** Count abilities that fired this frame by diffing cooldown timestamps before/after. */
    private tallyCasts(runAbilities: () => void): void {
      const state = this.world.abilityStatesByEntity.get(this.playerEid);
      const before = new Map(state?.cooldownByAbilityId ?? []);
      runAbilities();
      const after = state?.cooldownByAbilityId;
      if (!after) return;
      for (const [abilityId, frame] of after) {
        if (before.get(abilityId) !== frame) {
          this.castCounts.set(abilityId, (this.castCounts.get(abilityId) ?? 0) + 1);
        }
      }
    }

    private applyPlayerSpeedSetting(): void {
      if (this.playerEid < 0) return;
      const scale = PLAYER_SPEED > 0 ? settings.playerSpeed / PLAYER_SPEED : 1;
      const velocityX = (this.world.stores.velocity.x[this.playerEid] ?? 0) * scale;
      const velocityY = (this.world.stores.velocity.y[this.playerEid] ?? 0) * scale;
      setComponent(this.world.ecs, this.playerEid, Velocity, { x: velocityX, y: velocityY });
    }

    private applyInfiniteMana(): void {
      if (settings.infiniteMana) {
        this.world.playerMp = this.world.playerMaxMp;
      }
    }

    private applyInvulnerability(): void {
      if (!settings.invulnerable || this.playerEid < 0) return;
      const max = this.world.stores.health.max[this.playerEid] ?? 100;
      this.world.stores.health.current[this.playerEid] = max;
    }

    private damagePlayer(): void {
      if (this.playerEid < 0) return;
      const max = this.world.stores.health.max[this.playerEid] ?? 100;
      this.world.stores.health.current[this.playerEid] = Math.max(1, Math.round(max * 0.4));
    }

    private triggerHits(): void {
      if (this.playerEid < 0) return;
      queueAbilityTrigger(this.world, {
        holderEid: this.playerEid,
        kind: 'skill_usage',
        metric: 'hits_landed',
        amount: 10,
      });
    }

    private applySpawnerBounds(): void {
      configureEnemySpawner(this.world, {
        width: pxToFt(this.getSimulationWidth()),
        height: pxToFt(this.getSimulationHeight()),
      });
    }

    private getSimulationHeight(): number {
      return Math.max(1, Math.round(this.scale.height || this.cameras.main.height || GAME.HEIGHT));
    }

    private getSimulationWidth(): number {
      return Math.max(1, Math.round(this.scale.width || this.cameras.main.width || GAME.WIDTH));
    }

    private resetWorld(): void {
      this.accumulator = 0;
      this.castCounts.clear();
      this.world = createGameWorld({ seed: LAB_SEED });
      this.world.featureUnlocks.spells = true;
      this.playerEid = spawnPlayer(
        this.world,
        pxToFt(this.getSimulationWidth()) / 2,
        pxToFt(this.getSimulationHeight()) / 2,
      );
      initializeBaseStats(this.world, this.playerEid);
      addComponent(this.world.ecs, this.playerEid, set(BroadcastScore, { current: 0 }));
      const weapon = WEAPON_DEFS.get(settings.activeWeapon);
      if (weapon !== undefined) {
        setActiveWeapon(this.world, weapon);
      }
      this.syncEquippedAbilities();
      this.applySpawnerBounds();
      this.bridge?.sync(this.world);
      this.updateHud();
    }

    /** Equip/grant abilities from the lab toggles onto the player. */
    syncEquippedAbilities(): void {
      if (this.playerEid < 0) return;
      for (const def of ABILITIES) {
        if (!equipped[def.id]) {
          if (def.kind !== 'passive') unequipActiveAbility(this.world, this.playerEid, def.id);
          continue;
        }
        if (def.kind === 'passive') {
          grantPassiveAbility(this.world, this.playerEid, def.id);
        } else if (def.kind === 'spell') {
          memorizeSpell(this.world, this.playerEid, def.id);
        } else {
          equipActiveAbility(this.world, this.playerEid, def.id);
        }
      }
    }

    private updateHud(): void {
      const playerHp =
        this.playerEid >= 0 ? (this.world.stores.health.current[this.playerEid] ?? 0) : 0;
      const enemyCount = query(this.world.ecs, [Enemy]).length;
      const state = this.world.abilityStatesByEntity.get(this.playerEid);
      const active = state?.equippedActiveAbilityIds ?? [];
      const passives = state?.passiveAbilityIds ?? [];
      const castLines = ABILITIES.filter((d) => equipped[d.id]).map((d) => {
        const casts = this.castCounts.get(d.id) ?? 0;
        return `  ${d.name}: ${d.kind === 'passive' ? 'on' : `${casts} cast`}`;
      });

      hud.textContent = [
        `MP: ${this.world.playerMp.toFixed(0)} / ${this.world.playerMaxMp.toFixed(0)}`,
        `Player HP: ${playerHp.toFixed(0)}`,
        `Enemies: ${enemyCount}`,
        `Active/Spell slots: ${active.length}  Passives: ${passives.length}`,
        'Abilities:',
        ...castLines,
        `State: ${this.world.state}`,
      ].join('\n');
    }
  }

  let scene: AbilitiesLabScene | undefined;

  function persistState(): void {
    saveLabState<AbilitiesLabSnapshot>(LAB_ID, { settings, equipped });
  }

  const controlsApi = {
    reset: () => resetWorldFromGui(),
    damage: () => damagePlayerFromGui(),
    hits: () => triggerHitsFromGui(),
  };

  gui
    .add(settings, 'activeWeapon', WEAPON_IDS)
    .name('Auto-Weapon')
    .onChange(() => resetWorldFromGui());

  const abilityFolder = gui.addFolder('Abilities');
  abilityFolder.open();
  for (const def of ABILITIES) {
    abilityFolder
      .add(equipped, def.id)
      .name(`${def.name} (${abilityKindLabel(def)})`)
      .onChange(() => {
        scene?.syncEquippedAbilities();
        persistState();
      });
  }

  gui.add(controlsApi, 'damage').name('Take 60% HP');
  gui.add(controlsApi, 'hits').name('Trigger hits→10');

  const arena = gui.addFolder('Arena');
  arena.add(settings, 'infiniteMana').name('Infinite Mana');
  arena.add(settings, 'invulnerable').name('Invulnerable');
  arena.add(settings, 'playerSpeed', 0.125, 1.875, 0.0125).name('Player Speed');
  arena.add(settings, 'maxEnemies', 5, 200, 1).name('Max Enemies');
  arena.add(settings, 'spawnIntervalMs', 100, 5000, 1).name('Spawn Interval');
  arena.add(settings, 'enemyHp', 10, 500, 1).name('Enemy HP');
  arena.add(settings, 'enemySpeed', 0.0625, 0.625, 0.0125).name('Enemy Speed');
  arena.add(controlsApi, 'reset').name('Reset');

  gui.onChange(persistState);

  const getSize = () => ({
    width: Math.max(1, Math.round(gameHost.clientWidth || GAME.WIDTH)),
    height: Math.max(1, Math.round(gameHost.clientHeight || GAME.HEIGHT)),
  });

  const initialSize = getSize();
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: gameHost,
    width: initialSize.width,
    height: initialSize.height,
    backgroundColor: '#0c0e1a',
    scene: [AbilitiesLabScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  const game = new Phaser.Game(config);
  game.events.once('ready', () => {
    scene = game.scene.getScene('AbilitiesLabScene') as AbilitiesLabScene;
  });
  const resizeObserver = new ResizeObserver(() => {
    const nextSize = getSize();
    game.scale.resize(nextSize.width, nextSize.height);
  });
  resizeObserver.observe(gameHost);

  return () => {
    resizeObserver.disconnect();
    game.destroy(true);
    hint.remove();
    root.remove();
  };
}

registerLab('abilities-lab', {
  category: 'Combat' as LabCategory,
  name: 'Abilities Lab',
  description:
    'Spawn enemies and test real abilities (spells, actives, passives) in the live combat engine. ' +
    'Equip via toggles; abilities fire on their true triggers and spend MP.',
  create: createAbilitiesLab,
});
