import GUI from 'lil-gui';
import {
  DEFAULT_RELATION,
  adjustFactionRelation,
  bandFor,
  createGameWorld,
  familyRelationshipSystem,
  getRelation,
  initializeFactionRelations,
  queueFactionRelationDelta,
  selectFloor2Roster,
  type FamilyId,
  type GameWorld,
} from '../../core/index.js';
import { SeededRandom } from '../../shared/random.js';
import { loadFamilies, type FamilyDef } from '../../shared/data/families.js';
import { loadResources, type ResourceDef } from '../../shared/data/resources.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function bandColor(band: string): string {
  switch (band) {
    case 'hate':
      return '#ff3838';
    case 'hostile':
      return '#ff9933';
    case 'neutral':
      return '#c9c9c9';
    case 'friendly':
      return '#4bd964';
    default:
      return '#888';
  }
}

function createFamilyTerritoryLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const families: readonly FamilyDef[] = loadFamilies();
  const resources: readonly ResourceDef[] = loadResources();

  const state = {
    seed: 424242,
    fourFamilyProb: 0.4,
  };

  const world: GameWorld = createGameWorld({ seed: state.seed });
  world.state = 'playing';

  let familyIndex: Map<FamilyId, FamilyDef> = new Map();
  let contested: ResourceDef | null = null;

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;line-height:1.55;overflow:auto;max-height:640px;';
  canvasHost.append(panel);

  function reseed(): void {
    const rng = new SeededRandom(state.seed);
    const roster = selectFloor2Roster(rng, families, resources, {
      presentCountFourProbability: state.fourFamilyProb,
    });
    familyIndex = new Map(
      roster.presentFamilies.map((id) => [id, families.find((f) => f.id === id)!]),
    );
    contested = resources.find((r) => r.id === roster.contestedResource) ?? null;
    world.factionRelationDeltas.length = 0;
    world.factionRelationEvents.length = 0;
    initializeFactionRelations(world, roster.presentFamilies);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: roster.presentFamilies.slice(),
        contestedResource: roster.contestedResource,
        betrayerFlag: false,
      },
    };
    render();
  }

  function render(): void {
    if (!contested) {
      panel.textContent = 'No roster.';
      return;
    }
    const lines: string[] = [];
    lines.push(
      `<b>Contested resource:</b> ${contested.name} <span style="color:#7ee0ff">(${contested.streetName})</span> → ${contested.product}`,
    );
    lines.push(`<b>Present families (${familyIndex.size}):</b>`);
    lines.push('');
    for (const [id, def] of familyIndex.entries()) {
      const r = getRelation(world, id);
      const band = bandFor(r);
      const swatch = `<span style="display:inline-block;width:12px;height:12px;background:${def.hudColor};margin-right:8px;vertical-align:middle;border-radius:2px;"></span>`;
      const barPct = Math.max(0, Math.min(100, r));
      const bar = `<span style="display:inline-block;width:160px;height:8px;background:#222;vertical-align:middle;margin:0 8px;"><span style="display:inline-block;width:${barPct}%;height:100%;background:${bandColor(band)};"></span></span>`;
      lines.push(
        `${swatch}<b>${def.name}</b> <span style="color:#888">(${def.species})</span>${bar}<b style="color:${bandColor(band)}">${band}</b> ${r.toFixed(0)}/100 — sig. ${def.signature}`,
      );
    }
    lines.push('');
    lines.push(
      `<span style="color:#888">Betrayer flag: ${world.floorExtendedState?.familyState?.betrayerFlag ? 'YES' : 'no'} · Queued deltas: ${world.factionRelationDeltas.length} · Emitted events (session): ${world.factionRelationEvents.length}</span>`,
    );
    lines.push('');
    lines.push('<b>Recent events</b>');
    const recent = world.factionRelationEvents.slice(-8).reverse();
    if (recent.length === 0) lines.push('<span style="color:#888">(none)</span>');
    for (const evt of recent) {
      const def = familyIndex.get(evt.familyId);
      const label = def?.name ?? evt.familyId;
      lines.push(
        `• ${label}: ${evt.before}→${evt.after} <span style="color:${bandColor(evt.band)}">[${evt.previousBand}→${evt.band}]</span>`,
      );
    }
    panel.innerHTML = lines.join('<br/>');
  }

  function pickAny(): FamilyId | null {
    const first = familyIndex.keys().next();
    return first.done ? null : first.value;
  }

  const actions = {
    reseed: () => reseed(),
    rerollSeed: () => {
      state.seed = (state.seed * 1103515245 + 12345) & 0x7fffffff;
      reseed();
    },
    plus5AllPresent: () => {
      for (const id of familyIndex.keys()) {
        queueFactionRelationDelta(world, { familyId: id, delta: 5, reason: 'lab +5' });
      }
      familyRelationshipSystem(world);
      render();
    },
    minus10Focus: () => {
      const id = pickAny();
      if (!id) return;
      queueFactionRelationDelta(world, { familyId: id, delta: -10, reason: 'lab -10' });
      familyRelationshipSystem(world);
      render();
    },
    hateSpike: () => {
      const id = pickAny();
      if (!id) return;
      adjustFactionRelation(world, id, -50);
      render();
    },
    betrayAlly: () => {
      const id = pickAny();
      if (!id) return;
      adjustFactionRelation(world, id, 100 - getRelation(world, id));
      adjustFactionRelation(world, id, -60);
      if (world.floorExtendedState?.familyState)
        world.floorExtendedState.familyState.betrayerFlag = true;
      render();
    },
    resetRelations: () => {
      for (const id of familyIndex.keys()) {
        adjustFactionRelation(world, id, DEFAULT_RELATION - getRelation(world, id));
      }
      if (world.floorExtendedState?.familyState)
        world.floorExtendedState.familyState.betrayerFlag = false;
      render();
    },
  };

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => reseed());
  gui
    .add(state, 'fourFamilyProb', 0, 1, 0.05)
    .name('P(4 families)')
    .onFinishChange(() => reseed());
  gui.add(actions, 'reseed').name('↻ Reseed with current seed');
  gui.add(actions, 'rerollSeed').name('🎲 Reroll seed');
  gui.add(actions, 'plus5AllPresent').name('+5 to all (via delta queue)');
  gui.add(actions, 'minus10Focus').name('-10 to first family');
  gui.add(actions, 'hateSpike').name('-50 to first family (hate)');
  gui.add(actions, 'betrayAlly').name('Betray ally (first family)');
  gui.add(actions, 'resetRelations').name('Reset all to default (45)');

  reseed();

  const hint = document.createElement('p');
  hint.textContent =
    'Family Territory Lab — deterministic Floor-2 roster selection + relationship-band playground. Tick the delta buttons and watch bands shift.';
  hint.style.cssText =
    'padding:8px 16px;color:#bfdbfe;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('family-territory-lab', {
  category: 'Entities' as LabCategory,
  name: 'Family Territory Lab',
  description:
    'Seed a Floor-2 roster, watch relationship bands shift, and probe band boundaries and the betrayer latch.',
  create: createFamilyTerritoryLab,
});
