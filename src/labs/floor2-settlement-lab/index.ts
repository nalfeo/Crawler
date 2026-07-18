/**
 * Floor 2 · Slice 6 — Settlement Lab.
 *
 * Renders the current Floor-2 emergent-event ledger + the settlement's
 * seeded shop inventories, and exposes "trigger event N" buttons that
 * force-fire each authored event so its faction-relation deltas propagate
 * through `familyRelationshipSystem` on the next tick.
 *
 * Deterministic — same seed reproduces the same shops. Companion to
 * `family-territory-lab` (which owns roster selection + band probing).
 */
import GUI from 'lil-gui';
import {
  DEFAULT_RELATION,
  asFamilyId,
  bandFor,
  createGameWorld,
  familyRelationshipSystem,
  getRelation,
  initializeFactionRelations,
  type FamilyId,
  type GameWorld,
} from '../../core/index.js';
import {
  emergentEventSystem,
  forceFireEmergentEvent,
  getFiredEmergentEvents,
  _resetEmergentEventScheduler,
} from '../../game/systems/emergentEventSystem.js';
import {
  loadEmergentEventPack,
  _resetEmergentEventCache,
} from '../../shared/data/emergent-events.js';
import { loadShopArchetypes, type ShopArchetypeDef } from '../../shared/data/shop-archetypes.js';
import { generateShopInventory } from '../../core/generateShopInventory.js';
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';
import { QUARTERMASTER_ARCHETYPE_ID } from '../../game/floor2Settlement.js';
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

function createSettlementLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const state = { seed: 4242, shopCount: 2 };

  const families: FamilyId[] = [
    asFamilyId('lab-family-a'),
    asFamilyId('lab-family-b'),
    asFamilyId('lab-family-c'),
    asFamilyId('lab-family-d'),
  ];
  const world: GameWorld = createGameWorld({ seed: state.seed });
  world.state = 'playing';

  let quartermasterShop: {
    arch: ShopArchetypeDef;
    inv: ReturnType<typeof generateShopInventory>;
  } | null = null;
  let shops: Array<{ arch: ShopArchetypeDef; inv: ReturnType<typeof generateShopInventory> }> = [];

  const panel = document.createElement('div');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;line-height:1.55;overflow:auto;max-height:640px;';
  canvasHost.append(panel);

  function reseed(): void {
    _resetEmergentEventScheduler(world);
    _resetEmergentEventCache();
    const rng = new SeededRandom(state.seed);
    world.rng = new SeededRandom(state.seed);
    world.elapsedMs = 0;
    world.factionRelationDeltas.length = 0;
    world.factionRelationEvents.length = 0;
    initializeFactionRelations(world, families);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: families.slice(),
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
      },
    };
    const archetypes = loadShopArchetypes();

    // Build a settlement RNG that mirrors initializeFloor2Settlement's state
    // at the point where QM inventory is rolled:
    //   seed  : hashStringToSeed(`floor2-settlement:${world.seed}`)
    //   pre-advances: 1 (defector family pick) + 3 (broker/defector/QM tile picks)
    //                 + state.shopCount (non-QM shop tile picks, processed before QM inventory)
    const settlementRng = new SeededRandom(hashStringToSeed(`floor2-settlement:${state.seed}`));
    const preAdvanceCount = 1 + 3 + state.shopCount; // 1 defector family + 3 tile picks (broker/defector/QM) + shopCount non-QM tile picks
    for (let i = 0; i < preAdvanceCount; i += 1) settlementRng.nextInt(0, 1);

    // Quartermaster is always guaranteed — exclude from random pool.
    const qmArch = archetypes.find((a) => a.id === QUARTERMASTER_ARCHETYPE_ID) ?? null;
    if (qmArch) {
      quartermasterShop = { arch: qmArch, inv: generateShopInventory(settlementRng, qmArch) };
    }
    const randomPool = archetypes.filter((a) => a.id !== QUARTERMASTER_ARCHETYPE_ID);
    const shuffled = [...randomPool];
    rng.shuffle(shuffled);
    shops = shuffled.slice(0, state.shopCount).map((arch) => ({
      arch,
      inv: generateShopInventory(rng, arch),
    }));
    render();
  }

  function render(): void {
    const lines: string[] = [];
    const fired = getFiredEmergentEvents(world);

    lines.push('<b>The Broker</b>');
    lines.push(
      '<span style="color:#bfdbfe">Contestant, sit. The families are watching the tape…</span>',
    );
    lines.push('');
    lines.push(`<b>Shops (seeded @ ${state.seed})</b>`);
    if (quartermasterShop) {
      lines.push(
        `<span style="color:#fbbf24">★ Guaranteed: ${quartermasterShop.arch.name}</span> <span style="color:#888">(${quartermasterShop.arch.id})</span>`,
      );
      for (const item of quartermasterShop.inv.items) {
        lines.push(
          `&nbsp;&nbsp;<span style="color:#a0f0a0">${item.itemId}</span> — <b>${item.unitPrice}</b>g`,
        );
      }
    }
    for (const { arch, inv } of shops) {
      lines.push(
        `<span style="color:#fddb80">• ${arch.name}</span> <span style="color:#888">(${arch.id})</span>`,
      );
      for (const item of inv.items) {
        lines.push(
          `&nbsp;&nbsp;<span style="color:#a0f0a0">${item.itemId}</span> — <b>${item.unitPrice}</b>g`,
        );
      }
    }
    lines.push('');
    lines.push('<b>Present families</b>');
    for (const id of families) {
      const r = getRelation(world, id);
      const band = bandFor(r);
      lines.push(
        `<span style="color:${bandColor(band)}">■</span> ${id} — <b style="color:${bandColor(band)}">${band}</b> ${r.toFixed(0)}/100`,
      );
    }
    lines.push('');
    lines.push('<b>Emergent events</b>');
    const pack = loadEmergentEventPack();
    for (const ev of pack.events) {
      const marker = fired.has(ev.id) ? '✓' : '·';
      const color = fired.has(ev.id) ? '#4bd964' : '#888';
      lines.push(
        `<span style="color:${color}">${marker}</span> <b>${ev.title}</b> <span style="color:#888">(${ev.trigger.type})</span>`,
      );
    }
    panel.innerHTML = lines.join('<br/>');
  }

  const actions = {
    reseed: () => {
      reseed();
    },
    rerollSeed: () => {
      state.seed = Math.floor(Math.random() * 1_000_000);
      reseed();
    },
    tick: () => {
      world.elapsedMs += 250;
      familyRelationshipSystem(world);
      emergentEventSystem(world);
      render();
    },
    fireTurfWar: () => {
      forceFireEmergentEvent(world, 'floor2-event-turf-war-flashpoint');
      familyRelationshipSystem(world);
      render();
    },
    fireTribute: () => {
      forceFireEmergentEvent(world, 'floor2-event-tribute-run');
      familyRelationshipSystem(world);
      render();
    },
    fireHit: () => {
      forceFireEmergentEvent(world, 'floor2-event-the-hit');
      familyRelationshipSystem(world);
      render();
    },
    fireProtection: () => {
      forceFireEmergentEvent(world, 'floor2-event-protection-racket');
      familyRelationshipSystem(world);
      render();
    },
    fireBetrayal: () => {
      forceFireEmergentEvent(world, 'floor2-event-betrayal-tax');
      familyRelationshipSystem(world);
      render();
    },
    firePoison: () => {
      forceFireEmergentEvent(world, 'floor2-event-poison-the-well');
      familyRelationshipSystem(world);
      render();
    },
    resetRelations: () => {
      initializeFactionRelations(world, families);
      _resetEmergentEventScheduler(world);
      render();
    },
    resetAll: () => {
      void DEFAULT_RELATION;
      reseed();
    },
  };

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => reseed());
  gui
    .add(state, 'shopCount', [1, 2])
    .name('Shop count')
    .onFinishChange(() => reseed());
  gui.add(actions, 'reseed').name('↻ Reseed with current seed');
  gui.add(actions, 'rerollSeed').name('🎲 Reroll seed');
  gui.add(actions, 'tick').name('▶ Advance 250ms (natural triggers)');
  gui.add(actions, 'fireTurfWar').name('★ Turf-War Flashpoint');
  gui.add(actions, 'fireTribute').name('★ Tribute Run');
  gui.add(actions, 'fireHit').name('★ The Hit');
  gui.add(actions, 'fireProtection').name('★ Protection Racket');
  gui.add(actions, 'fireBetrayal').name('★ Betrayal Tax');
  gui.add(actions, 'firePoison').name('★ Poison the Well');
  gui.add(actions, 'resetRelations').name('Reset relations');
  gui.add(actions, 'resetAll').name('Reset all');

  reseed();

  const hint = document.createElement('p');
  hint.textContent =
    'Settlement Lab — seeded shops + The Broker + emergent-event ledger. Fire an event to see the delta queue land in the next familyRelationshipSystem drain.';
  hint.style.cssText =
    'padding:8px 16px;color:#bfdbfe;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    panel.remove();
    hint.remove();
  };
}

registerLab('floor2-settlement-lab', {
  category: 'Entities' as LabCategory,
  name: 'Floor 2 Settlement Lab',
  description:
    'Preview the Floor-2 settlement — The Broker, seeded shop inventories, and the emergent-event ledger — with "trigger event N" buttons that force-fire each authored event.',
  create: createSettlementLab,
});
