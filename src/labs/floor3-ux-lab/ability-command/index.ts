/**
 * Floor 3 Ability Command Lab — game-design §15 surface 7.
 *
 * Fires the companion command verb through the real HUD, showing the command
 * pips, per-Companion cooldown, and the player-level-scaled charge capacity.
 */
import { createFloor3UxLab } from '../harness.js';
import { registerLab, type LabCategory } from '../../registry.js';

const createAbilityCommandLab = createFloor3UxLab({
  legend:
    'Floor 3 ability command (surface 7): [C] commands the lowest ready party slot. Charges scale with player level; each commanded Companion recharges on its own cooldown.',
  buildControls(gui, ctx) {
    const state = { playerLevel: ctx.fixture.world.playerLevel.level, slot: 1, lastResult: '—' };
    const resultControl = gui.add(state, 'lastResult').name('Last command').listen().disable();
    gui
      .add(state, 'playerLevel', 1, 30, 1)
      .name('Player level')
      .onChange((value: number) => {
        ctx.fixture.world.playerLevel.level = value;
        ctx.refresh();
      });
    gui.add(state, 'slot', 1, ctx.fixture.partyEids.length, 1).name('Target slot');
    gui
      .add(
        {
          command: () => {
            const result = ctx.hudUi.issueFloor3Command(
              ctx.fixture.world,
              ctx.fixture.playerEid,
              state.slot - 1,
            );
            state.lastResult = result.accepted
              ? `${result.row.formName} → ${result.abilityName}`
              : result.rejection;
            resultControl.updateDisplay();
            ctx.refresh();
          },
        },
        'command',
      )
      .name('⚡ Command slot');
    gui.add({ advance: () => ctx.advanceFrames(60) }, 'advance').name('⏱ Advance 60 frames');
    gui
      .add({ recharge: () => ctx.advanceFrames(300) }, 'recharge')
      .name('⏱ Advance 300 frames (recharge)');
  },
});

registerLab('floor3-ability-command-lab', {
  category: 'Meta' as LabCategory,
  name: 'Floor 3 Ability Command',
  description: 'Floor 3 — companion command verb: charges, cooldown pips, rejection reasons.',
  create: createAbilityCommandLab,
});
