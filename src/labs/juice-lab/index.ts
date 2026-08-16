import GUI from 'lil-gui';
import Phaser from 'phaser';
import { createGameWorld, type GameWorld } from '../../core/index.js';
import { createEffectsVfx } from '../../engine/EffectsVfx.js';
import { GAME } from '../../shared/constants.js';
import { pxToFt } from '../../shared/units.js';
import type { CombatEvent } from '../../shared/combat-events.js';
import {
  PICKUP_SPARKLE_COLORS,
  pushVfxEvent,
  type VfxEffectKind,
} from '../../shared/vfx-events.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 7321;
const BLOOD_RED = 0xcc0000;
const BLOOD_GREEN = 0x22aa44;
const LEVEL_UP_GOLD = 0xffd166;

interface JuiceLabSettings {
  autoFire: boolean;
  autoFireRateMs: number;
}

function createJuiceLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: JuiceLabSettings = {
    autoFire: false,
    autoFireRateMs: 320,
  };

  const root = document.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = 'radial-gradient(circle at top, #101a2b 0%, #0a0f1c 50%, #05050a 100%)';

  const gameHost = document.createElement('div');
  gameHost.style.width = '100%';
  gameHost.style.height = '100%';

  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '16px';
  hud.style.left = '16px';
  hud.style.padding = '12px 14px';
  hud.style.borderRadius = '12px';
  hud.style.background = 'rgba(7, 12, 24, 0.78)';
  hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  hud.style.color = '#f8fafc';
  hud.style.lineHeight = '1.5';
  hud.style.whiteSpace = 'pre-line';
  hud.style.pointerEvents = 'none';

  const hint = document.createElement('p');
  hint.textContent =
    'Trigger effects with the buttons on the right, or enable Auto-fire for a continuous Vampire-Survivors-style density preview.';
  hint.style.marginTop = '16px';
  hint.style.color = '#bfdbfe';
  hint.style.lineHeight = '1.6';

  controls.append(hint);
  root.append(gameHost, hud);
  canvasHost.append(root);

  let lastAction = 'none';

  class JuiceLabScene extends Phaser.Scene {
    private effects?: ReturnType<typeof createEffectsVfx>;
    private world!: GameWorld;
    private autoFireAccum = 0;
    private autoFireStep = 0;

    constructor() {
      super({ key: 'JuiceLabScene' });
    }

    create(): void {
      this.cameras.main.setBackgroundColor('#0a0f1c');
      this.world = createGameWorld({ seed: LAB_SEED });
      this.effects = createEffectsVfx(this);

      this.events.once('shutdown', () => {
        this.effects?.destroy();
        this.effects = undefined;
      });
    }

    // VFX/combat events carry feet; EffectsVfx scales feet→pixels at draw time.
    private center(): { x: number; y: number } {
      return {
        x: pxToFt(this.scale.width || GAME.WIDTH) / 2,
        y: pxToFt(this.scale.height || GAME.HEIGHT) / 2,
      };
    }

    /** Random point in a band around the centre for auto-fire variety. */
    private scatterPoint(): { x: number; y: number } {
      const w = pxToFt(this.scale.width || GAME.WIDTH);
      const h = pxToFt(this.scale.height || GAME.HEIGHT);
      return {
        x: w / 2 + (Math.random() - 0.5) * w * 0.6,
        y: h / 2 + (Math.random() - 0.5) * h * 0.6,
      };
    }

    fireVfx(kind: VfxEffectKind, color: number, at?: { x: number; y: number }): void {
      const p = at ?? this.center();
      pushVfxEvent(this.world.vfxEvents, { kind, x: p.x, y: p.y, color });
      lastAction = kind;
    }

    fireCombat(event: Omit<CombatEvent, 'timestamp'>): void {
      this.world.combatEvents.push({ ...event, timestamp: this.world.elapsedMs });
      lastAction = `${event.type}${event.isCrit ? ' crit' : ''}/${event.targetType}`;
    }

    fireHit(crit: boolean, at?: { x: number; y: number }): void {
      const p = at ?? this.center();
      this.fireCombat({
        type: 'hit',
        x: p.x,
        y: p.y,
        amount: crit ? 24 : 8,
        targetType: 'enemy',
        isCrit: crit,
      });
    }

    fireDeath(bloodColor: number, at?: { x: number; y: number }): void {
      const p = at ?? this.center();
      this.fireCombat({
        type: 'death',
        x: p.x,
        y: p.y,
        amount: 30,
        targetType: 'enemy',
        overkill: 15,
        bloodColor,
      });
    }

    firePlayerHurt(at?: { x: number; y: number }): void {
      const p = at ?? this.center();
      this.fireCombat({ type: 'hit', x: p.x, y: p.y, amount: 12, targetType: 'player' });
    }

    private triggerRandom(): void {
      const p = this.scatterPoint();
      const roll = this.autoFireStep % 6;
      this.autoFireStep += 1;
      switch (roll) {
        case 0:
          this.fireVfx('pickupSparkle', PICKUP_SPARKLE_COLORS.gem, p);
          break;
        case 1:
          this.fireVfx('pickupSparkle', PICKUP_SPARKLE_COLORS.gold, p);
          break;
        case 2:
          this.fireHit(false, p);
          break;
        case 3:
          this.fireHit(true, p);
          break;
        case 4:
          this.fireDeath(this.autoFireStep % 2 === 0 ? BLOOD_RED : BLOOD_GREEN, p);
          break;
        default:
          this.fireVfx('levelUpBurst', LEVEL_UP_GOLD, p);
          break;
      }
    }

    update(_time: number, delta: number): void {
      if (!this.effects) return;
      this.world.elapsedMs += delta;

      if (settings.autoFire) {
        this.autoFireAccum += delta;
        while (this.autoFireAccum >= settings.autoFireRateMs) {
          this.triggerRandom();
          this.autoFireAccum -= settings.autoFireRateMs;
        }
      }

      // EffectsVfx reads combatEvents (without draining) and drains vfxEvents.
      this.effects.update(this.world, this.world.elapsedMs);
      // The real game relies on CombatVfx to drain combatEvents; the lab has no
      // CombatVfx, so drain here or events would re-fire every frame.
      this.world.combatEvents.length = 0;

      hud.textContent = [
        `Last effect: ${lastAction}`,
        `Auto-fire: ${settings.autoFire ? 'on' : 'off'} (${settings.autoFireRateMs}ms)`,
      ].join('\n');
    }
  }

  const sceneRef: { scene?: JuiceLabScene } = {};
  const withScene = (fn: (scene: JuiceLabScene) => void) => () => {
    if (sceneRef.scene) fn(sceneRef.scene);
  };

  const actions: Record<string, () => void> = {
    'Pickup: Gem': withScene((s) => s.fireVfx('pickupSparkle', PICKUP_SPARKLE_COLORS.gem)),
    'Pickup: Gold': withScene((s) => s.fireVfx('pickupSparkle', PICKUP_SPARKLE_COLORS.gold)),
    'Pickup: Item': withScene((s) => s.fireVfx('pickupSparkle', PICKUP_SPARKLE_COLORS.item)),
    'Level Up': withScene((s) => s.fireVfx('levelUpBurst', LEVEL_UP_GOLD)),
    'Hit Spark': withScene((s) => s.fireHit(false)),
    'Crit Burst': withScene((s) => s.fireHit(true)),
    'Death Pop (red)': withScene((s) => s.fireDeath(BLOOD_RED)),
    'Death Pop (green)': withScene((s) => s.fireDeath(BLOOD_GREEN)),
    'Player Hurt': withScene((s) => s.firePlayerHurt()),
  };

  const triggers = gui.addFolder('Trigger');
  for (const label of Object.keys(actions)) {
    triggers.add(actions, label);
  }
  const auto = gui.addFolder('Auto-fire');
  auto.add(settings, 'autoFire').name('Enabled');
  auto.add(settings, 'autoFireRateMs', 80, 800, 20).name('Rate (ms)');

  const getSize = () => ({
    width: Math.max(1, Math.round(gameHost.clientWidth || GAME.WIDTH)),
    height: Math.max(1, Math.round(gameHost.clientHeight || GAME.HEIGHT)),
  });

  const initialSize = getSize();
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.CANVAS,
    parent: gameHost,
    width: initialSize.width,
    height: initialSize.height,
    backgroundColor: '#0a0f1c',
    scene: [JuiceLabScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    callbacks: {
      postBoot: (game) => {
        sceneRef.scene = game.scene.getScene('JuiceLabScene') as JuiceLabScene;
      },
    },
  };

  const game = new Phaser.Game(config);
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

registerLab('juice-lab', {
  category: 'Combat' as LabCategory,
  name: 'Juice Lab',
  description:
    'Preview the EffectsVfx juice library: pickup sparkles, level-up bursts, hit sparks, crit bursts, death pops, and player-hurt pulse. Buttons fire single effects; Auto-fire stress-tests density.',
  create: createJuiceLab,
});
