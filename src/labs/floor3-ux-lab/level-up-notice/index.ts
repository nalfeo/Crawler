/**
 * Floor 3 Level-Up Notice Lab — game-design §15 surface 6.
 *
 * Grants levels to a party member and watches the HUD notice strip announce
 * level-ups, evolutions, and newly learned ability milestones, then expire.
 */
import { createFloor3UxLab } from '../harness.js';
import { registerLab, type LabCategory } from '../../registry.js';

const createLevelUpNoticeLab = createFloor3UxLab({
  legend:
    'Floor 3 progression notices (surface 6): level-up, evolution, and ability-milestone lines appear in slot order and expire after their TTL.',
  buildControls(gui, ctx) {
    const state = { slot: 1, levels: 1 };
    gui.add(state, 'slot', 1, ctx.fixture.partyEids.length, 1).name('Party slot');
    gui.add(state, 'levels', 1, 12, 1).name('Levels to grant');
    gui
      .add(
        {
          grant: () => {
            const eid = ctx.fixture.partyEids[state.slot - 1];
            if (eid === undefined) return;
            const current = ctx.fixture.world.stores.companion.level[eid] ?? 1;
            ctx.fixture.world.stores.companion.level[eid] = current + state.levels;
            ctx.refresh();
          },
        },
        'grant',
      )
      .name('★ Grant levels');
    gui.add({ advance: () => ctx.advanceFrames(60) }, 'advance').name('⏱ Advance 60 frames');
    gui
      .add({ expire: () => ctx.advanceFrames(300) }, 'expire')
      .name('⏱ Advance 300 frames (expire)');
  },
});

registerLab('floor3-level-up-notice-lab', {
  category: 'Meta' as LabCategory,
  name: 'Floor 3 Level-Up Notices',
  description: 'Floor 3 — level-up / evolution / ability-learned HUD notices and their expiry.',
  create: createLevelUpNoticeLab,
});
