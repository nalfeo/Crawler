/**
 * Floor 3 Roster Lab — game-design §15 surface 5.
 *
 * Opens the real `Floor3RosterUI` overlay on the shared fixture party: cursor
 * movement, persona summary, affinity strengths/weaknesses, evolution track,
 * and the five ability milestones with learned state.
 */
import { createFloor3UxLab } from '../harness.js';
import { registerLab, type LabCategory } from '../../registry.js';

const createRosterLab = createFloor3UxLab({
  openRoster: true,
  legend:
    'Floor 3 companion roster (surface 5): select a party member to inspect persona, matchup spread, evolution track, and ability milestones.',
  buildControls(gui, ctx) {
    gui
      .add({ prev: () => ctx.rosterUi.moveCursor(ctx.fixture.world, -1) }, 'prev')
      .name('▲ Previous companion');
    gui
      .add({ next: () => ctx.rosterUi.moveCursor(ctx.fixture.world, 1) }, 'next')
      .name('▼ Next companion');
    const state = { level: 12 };
    gui
      .add(state, 'level', 1, 40, 1)
      .name('Selected level')
      .onChange((value: number) => {
        const cursor = ctx.rosterUi.getState().cursor;
        const eid = ctx.fixture.partyEids[cursor];
        if (eid === undefined) return;
        ctx.fixture.world.stores.companion.level[eid] = value;
        ctx.refresh();
      });
  },
});

registerLab('floor3-roster-lab', {
  category: 'Meta' as LabCategory,
  name: 'Floor 3 Companion Roster',
  description:
    'Floor 3 — companion detail overlay: persona, affinity spread, evolution track, ability milestones.',
  create: createRosterLab,
});
