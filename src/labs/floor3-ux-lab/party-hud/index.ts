/**
 * Floor 3 Party HUD Lab — game-design §15 surface 4.
 *
 * Mounts the real `HudUI` (and therefore `HudFloor3Party`) over a Floor-3
 * party: per-member HP and KO toggles show the row, bar color, KO tag,
 * affinity swatch, and fighting-style glyph react live.
 */
import { createFloor3UxLab } from '../harness.js';
import { registerLab, type LabCategory } from '../../registry.js';

const createPartyHudLab = createFloor3UxLab({
  legend:
    'Floor 3 party HUD (surface 4): one row per party Companion — slot, form + level, HP bar, KO tag, affinity swatch, style glyph.',
  buildControls(gui, ctx) {
    ctx.fixture.partyEids.forEach((eid, index) => {
      const folder = gui.addFolder(`Slot ${index + 1}`);
      const state = {
        hp: ctx.fixture.world.stores.health.current[eid] ?? 100,
        knockedOut: (ctx.fixture.world.stores.companion.knockedOut[eid] ?? 0) === 1,
        level: ctx.fixture.world.stores.companion.level[eid] ?? 1,
      };
      folder
        .add(state, 'hp', 0, 100, 1)
        .name('HP')
        .onChange((value: number) => {
          ctx.fixture.world.stores.health.current[eid] = value;
          ctx.refresh();
        });
      folder
        .add(state, 'level', 1, 40, 1)
        .name('Level')
        .onChange((value: number) => {
          ctx.fixture.world.stores.companion.level[eid] = value;
          ctx.refresh();
        });
      folder
        .add(state, 'knockedOut')
        .name('Knocked out')
        .onChange((value: boolean) => {
          ctx.fixture.world.stores.companion.knockedOut[eid] = value ? 1 : 0;
          ctx.refresh();
        });
      folder.open();
    });
  },
});

registerLab('floor3-party-hud-lab', {
  category: 'Meta' as LabCategory,
  name: 'Floor 3 Party HUD',
  description: 'Floor 3 — party HUD rows: HP, KO, level, affinity swatch, fighting-style glyph.',
  create: createPartyHudLab,
});
