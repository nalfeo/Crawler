import GUI from 'lil-gui';
import { createGameWorld, manaSystem, spawnPlayer, type GameWorld } from '../../core/index.js';
import { initializeBaseStats } from '../../core/systems/equipmentSystem.js';
import { statSystem } from '../../core/systems/statSystem.js';
import {
  MANA_BASE,
  MANA_PER_WISDOM,
  MANA_REGEN_PER_FRAME,
  MANA_REGEN_PER_SECOND,
  deriveMaxMp,
} from '../../shared/mana.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const LAB_SEED = 42;
const MAX_WISDOM_POINTS = 20;

/**
 * Mana System Lab — verify the Wisdom→MP payoff and frame-based regen.
 *
 * Allocate Wisdom points and watch `playerMaxMp` rise (deriveMaxMp), drain the
 * pool, then step frames to watch `manaSystem` regenerate MP a fixed amount per
 * fixed-timestep frame (no Date.now). The same numbers the HUD mana bar reads.
 */
function createManaLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const params = { wisdomPoints: 0, framesStepped: 0 };

  let world: GameWorld = createGameWorld({ seed: LAB_SEED });
  let player = 0;

  function rebuild(): void {
    world = createGameWorld({ seed: LAB_SEED });
    world.state = 'safe_room';
    player = spawnPlayer(world, 0, 0);
    initializeBaseStats(world, player);
    world.stores.coreStatPoints.wisdom[player] = params.wisdomPoints;
    statSystem(world);
    manaSystem(world);
    // Start full so regen is visible only after a deliberate drain.
    world.playerMp = world.playerMaxMp;
    params.framesStepped = 0;
  }

  function applyWisdom(): void {
    world.stores.coreStatPoints.wisdom[player] = params.wisdomPoints;
    statSystem(world);
    manaSystem(world);
    render();
  }

  function stepFrames(count: number): void {
    for (let i = 0; i < count; i += 1) {
      statSystem(world);
      manaSystem(world);
    }
    params.framesStepped += count;
    render();
  }

  const root = document.createElement('div');
  root.style.cssText = 'padding:24px; color:#f8fafc; font-family:monospace; overflow:auto;';

  const title = document.createElement('h2');
  title.textContent = '⚡ Mana System Lab';

  const output = document.createElement('pre');
  output.style.cssText =
    'background:rgba(0,0,0,0.3); padding:16px; border-radius:8px; white-space:pre-wrap;';

  root.append(title, output);
  canvasHost.append(root);

  function render(): void {
    const effWisdom = world.stores.effectiveStats.wisdom[player] ?? 0;
    const lines: string[] = [
      '=== Mana (after statSystem + manaSystem tick) ===',
      '',
      `Allocated Wisdom points : +${params.wisdomPoints}`,
      `Effective Wisdom        : ${effWisdom.toFixed(2)}`,
      '',
      `Max MP  (deriveMaxMp)   : ${world.playerMaxMp.toFixed(2)}`,
      `Current MP              : ${world.playerMp.toFixed(2)}`,
      `MP fill                 : ${((world.playerMp / Math.max(1, world.playerMaxMp)) * 100).toFixed(1)}%`,
      '',
      `Frames stepped          : ${params.framesStepped}`,
      '',
      '--- tuning (shared/mana.ts) ---',
      `MANA_BASE               : ${MANA_BASE}`,
      `MANA_PER_WISDOM         : ${MANA_PER_WISDOM} / point`,
      `MANA_REGEN_PER_SECOND   : ${MANA_REGEN_PER_SECOND}`,
      `MANA_REGEN_PER_FRAME    : ${MANA_REGEN_PER_FRAME.toFixed(4)}`,
      '',
      `formula: ${MANA_BASE} + ${MANA_PER_WISDOM} × effWisdom ` +
        `= ${deriveMaxMp(effWisdom).toFixed(2)}`,
    ];
    output.textContent = lines.join('\n');
  }

  gui
    .add(params, 'wisdomPoints', 0, MAX_WISDOM_POINTS, 1)
    .name('Allocate Wisdom')
    .onChange(applyWisdom);

  gui
    .add(
      {
        drain: () => {
          world.playerMp = 0;
          render();
        },
      },
      'drain',
    )
    .name('Drain MP → 0');

  gui.add({ step: () => stepFrames(1) }, 'step').name('Step 1 frame');

  gui.add({ step: () => stepFrames(60) }, 'step').name('Step 1s (60 frames)');

  gui
    .add(
      {
        reset: () => {
          params.wisdomPoints = 0;
          rebuild();
          render();
        },
      },
      'reset',
    )
    .name('Reset');

  const hint = document.createElement('p');
  hint.textContent =
    'Allocate Wisdom to watch Max MP scale (manaSystem derives it from EFFECTIVE Wisdom each frame). ' +
    'Drain MP to 0, then step frames to watch deterministic, frame-based regen refill the pool — no Date.now, ' +
    'just MANA_REGEN_PER_FRAME derived from the fixed timestep. These are the same playerMp / playerMaxMp the HUD mana bar reads.';
  hint.style.cssText = 'margin-top:16px; color:#fbcfe8; line-height:1.6;';
  controls.append(hint);

  rebuild();
  render();

  return () => {
    root.remove();
    hint.remove();
  };
}

registerLab('mana-lab', {
  category: 'Progression' as LabCategory,
  name: 'Mana System Lab',
  description:
    'Verify the Wisdom→MP pool (deriveMaxMp) and deterministic frame-based MP regen applied by manaSystem.',
  create: createManaLab,
});
