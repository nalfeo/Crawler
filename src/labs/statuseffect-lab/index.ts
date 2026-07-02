import GUI from 'lil-gui';
import { addComponent, set } from 'bitecs';
import { createGameWorld, type GameWorld } from '../../core/index.js';
import { createEntity } from '../../core/helpers.js';
import { Health } from '../../core/components.js';
import {
  applyStatusEffect,
  clearStatusEffects,
  getStatusEffects,
  computeEffectiveSpeed,
  computeEffectiveValue,
} from '../../core/status-effects.js';
import { statusEffectSystem } from '../../core/systems/statusEffectSystem.js';
import { equip, unequip, initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../shared/equipmentDefs.js';
import { GAME } from '../../shared/constants.js';
import type { StatusEffectSpec } from '../../shared/status-effect-types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 42;
const BASE_SPEED = 100;
const START_HP = 60;
const MAX_HP = 100;

/** A trap chill: halve speed for 1.5s, replacing any prior chill. */
const CHILL_SLOW: StatusEffectSpec = {
  stat: 'speed',
  op: 'multiply',
  value: 0.5,
  durationMs: 1500,
  sourceType: 'trap',
  sourceId: 'chill',
  stackRule: { mode: 'replace' },
};

/** A haste buff: +40 flat speed for 1s. */
const HASTE_ADD: StatusEffectSpec = {
  stat: 'speed',
  op: 'add',
  value: 40,
  durationMs: 1000,
  sourceType: 'skill',
  sourceId: 'haste',
  stackRule: { mode: 'replace' },
};

/** A poison cloud: each application adds a 0.9x tick, capped at 3 stacks (2s each). */
const POISON_STACK: StatusEffectSpec = {
  stat: 'speed',
  op: 'multiply',
  value: 0.9,
  durationMs: 2000,
  sourceType: 'aura',
  sourceId: 'poison-cloud',
  stackRule: { mode: 'stack', maxStacks: 3 },
};

function createStatusEffectLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }
  const guiApi: GUI = gui;

  let world: GameWorld = createGameWorld({ seed: LAB_SEED });
  let entity = spawnSubject(world);
  let frame = 0;

  const root = document.createElement('div');
  root.style.cssText = 'padding:24px; color:#f8fafc; font-family:monospace; overflow:auto;';

  const title = document.createElement('h2');
  title.textContent = '✨ Status-Effect Framework Lab';

  const output = document.createElement('pre');
  output.style.cssText =
    'background:rgba(0,0,0,0.3); padding:16px; border-radius:8px; white-space:pre-wrap;';

  root.append(title, output);
  canvasHost.append(root);

  function render(): void {
    const effects = getStatusEffects(world, entity);
    const effSpeed = computeEffectiveSpeed(BASE_SPEED, effects);
    const regenRate = computeEffectiveValue(0, effects, 'hpRegen');
    const hp = world.stores.health.current[entity] ?? 0;
    const max = world.stores.health.max[entity] ?? MAX_HP;

    const lines: string[] = [
      '=== Status-Effect Framework ===',
      '',
      `frame: ${frame}   (dtMs/frame = ${GAME.DELTA_MS.toFixed(4)})`,
      '',
      'SPEED (read-site fold-in MODE):',
      `  base           ${BASE_SPEED.toFixed(2)}`,
      `  effective      ${effSpeed.toFixed(2)}   clamp[0, ${(BASE_SPEED * 3).toFixed(0)}]`,
      '  raw = (base + Σadd) * Π multiply',
      '',
      'HP-REGEN (per-tick apply MODE — heal-over-time):',
      `  rate           ${regenRate.toFixed(3)} HP/sec`,
      `  health         ${hp.toFixed(3)} / ${max.toFixed(0)}`,
      '',
      `ACTIVE EFFECTS (${effects.length}):`,
    ];

    if (effects.length === 0) {
      lines.push('  (none)');
    } else {
      for (const e of effects) {
        const remaining =
          e.remainingMs === Infinity ? 'persistent' : `${e.remainingMs.toFixed(0)}ms`;
        lines.push(
          `  ${e.stat.padEnd(8)} ${e.op.padEnd(8)} ${String(e.value).padEnd(6)}` +
            ` ${remaining.padStart(10)}  [${e.sourceType}:${e.sourceId}]`,
        );
      }
    }

    output.textContent = lines.join('\n');
  }

  function tick(frames: number): void {
    for (let i = 0; i < frames; i++) {
      statusEffectSystem(world);
      frame++;
    }
    render();
  }

  function addButton(label: string, handler: () => void): void {
    guiApi.add({ [label]: handler }, label).name(label);
  }

  addButton('Apply Chill (x0.5 speed, 1.5s)', () => {
    applyStatusEffect(world, entity, CHILL_SLOW);
    render();
  });
  addButton('Apply Haste (+40 speed, 1s)', () => {
    applyStatusEffect(world, entity, HASTE_ADD);
    render();
  });
  addButton('Apply Poison stack (x0.9, cap 3)', () => {
    applyStatusEffect(world, entity, POISON_STACK);
    render();
  });
  addButton('Equip Charm (HoT +0.75 HP/s)', () => {
    equip(world, entity, MERCHANTS_CHARM_DEF, { force: true });
    render();
  });
  addButton('Unequip Charm (clears HoT)', () => {
    unequip(world, entity, 'neck', { force: true });
    render();
  });
  addButton('Damage -25', () => {
    const cur = world.stores.health.current[entity] ?? 0;
    world.stores.health.current[entity] = Math.max(0, cur - 25);
    render();
  });
  addButton('Tick 1 frame', () => tick(1));
  addButton('Tick 60 frames (~1s)', () => tick(60));
  addButton('Clear all effects', () => {
    clearStatusEffects(world, entity);
    render();
  });
  addButton('Reset', () => {
    world = createGameWorld({ seed: LAB_SEED });
    entity = spawnSubject(world);
    frame = 0;
    render();
  });

  const hint = document.createElement('p');
  hint.textContent =
    'Exercises the generic status-effect framework: apply/replace/stack rules, timed expiry, ' +
    'persistent effects, and clamps. SPEED is folded in at read-sites (movement reads ' +
    'computeEffectiveSpeed); HP-REGEN is applied per-tick as a heal-over-time. Chill+Haste ' +
    'compose via product-of-factors + additive sum; Poison caps at 3 stacks (oldest dropped). ' +
    'Equip the Charm for a persistent HoT, damage yourself, then tick to watch HP recover ' +
    '(bounded to max, never below current). Timing is deterministic (fixed GAME.DELTA_MS per frame).';
  hint.style.cssText = 'margin-top:16px; color:#fbcfe8; line-height:1.6;';
  controls.append(hint);

  render();

  return () => {
    root.remove();
    hint.remove();
  };
}

/** Create the subject entity: Health + base stats, damaged so HoT is visible. */
function spawnSubject(world: GameWorld): number {
  world.state = 'safe_room';
  const entity = createEntity(world);
  addComponent(world.ecs, entity, set(Health, { current: START_HP, max: MAX_HP }));
  initializeBaseStats(world, entity);
  return entity;
}

registerLab('status-effect-lab', {
  category: 'Combat' as LabCategory,
  name: 'Status-Effect Framework Lab',
  description:
    'Apply / stack / expire / clamp timed stat modifiers; speed fold-in and hpRegen heal-over-time.',
  create: createStatusEffectLab,
});
