/**
 * Floor 3 Matchup Indicator Lab — game-design §15 surface 8.
 *
 * Moves a rival Companion in and out of engagement range and swaps its
 * affinity so the HUD chevron flips between strong / weak / neutral.
 */
import { AFFINITY_RING } from '../../../shared/data/floor3/affinity.js';
import { speciesTokenForId } from '../../../shared/data/floor3/species.js';
import { createFloor3UxLab } from '../harness.js';
import { registerLab, type LabCategory } from '../../registry.js';

/** One authored species per affinity, so the picker can retag the rival. */
const SPECIES_BY_AFFINITY = new Map(
  AFFINITY_RING.map((affinity) => [affinity, `${affinity}-warden`] as const),
);

const createMatchupLab = createFloor3UxLab({
  legend:
    'Floor 3 matchup indicator (surface 8): the chevron shows how each party Companion matches the nearest rival inside engagement range.',
  buildControls(gui, ctx) {
    const options = AFFINITY_RING.filter((affinity) => SPECIES_BY_AFFINITY.get(affinity));
    const state = { rivalAffinity: options[0] ?? 'ember', rivalDistanceFt: 6 };
    gui
      .add(state, 'rivalAffinity', options as unknown as string[])
      .name('Rival affinity')
      .onChange((value: string) => {
        const speciesId = SPECIES_BY_AFFINITY.get(value as (typeof AFFINITY_RING)[number]);
        if (speciesId === undefined) return;
        ctx.fixture.world.stores.companion.speciesToken[ctx.fixture.rivalEid] =
          speciesTokenForId(speciesId);
        ctx.refresh();
      });
    gui
      .add(state, 'rivalDistanceFt', 0, 40, 1)
      .name('Rival distance (ft)')
      .onChange((value: number) => {
        ctx.fixture.world.stores.position.x[ctx.fixture.rivalEid] = value;
        ctx.refresh();
      });
  },
});

registerLab('floor3-matchup-lab', {
  category: 'Meta' as LabCategory,
  name: 'Floor 3 Matchup Indicator',
  description: 'Floor 3 — affinity matchup chevron vs the nearest rival inside engagement range.',
  create: createMatchupLab,
});
