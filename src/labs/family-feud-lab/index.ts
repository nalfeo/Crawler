/**
 * Family Feud Lab — Floor 2 Slice 3.
 *
 * Text-mode inspector for band-driven target selection, hate speed ramp, and
 * friendly-band retaliation. Pits 3 families against each other in a small
 * arena; user controls the player position, per-family relation, and can
 * inject player-hit events to arm ally retaliation.
 */
import GUI from 'lil-gui';
import {
  DEFAULT_RELATION,
  adjustFactionRelation,
  asFamilyId,
  bandFor,
  createGameWorld,
  getRelation,
  initializeFactionRelations,
  type GameWorld,
} from '../../core/index.js';
import { FamilyMembership, spawnBehaviorEnemy, spawnPlayer } from '../../core/index.js';
import { addComponent, set } from 'bitecs';
import type { CombatEvent } from '../../shared/combat-events.js';
import tuning from '../../shared/data/tuning.json';
import {
  AI_TYPE,
  familyFeudSystem,
  getFamilyAIDecision,
  peekFriendlyRetaliation,
} from '../../game/index.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

const FAM_A = asFamilyId('crawler-syndicate');
const FAM_B = asFamilyId('rat-court');
const FAM_C = asFamilyId('bone-choir');
const FAMS = [FAM_A, FAM_B, FAM_C] as const;
const NAMES = ['Crawlers', 'Rat Court', 'Bone Choir'] as const;

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

function createFamilyFeudLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = {
    seed: 424242,
    playerX: 0,
    playerY: 0,
    relA: DEFAULT_RELATION,
    relB: DEFAULT_RELATION,
    relC: DEFAULT_RELATION,
  };

  let world: GameWorld = createGameWorld({ seed: state.seed });
  let playerEid = 0;
  const mobsPerFamily: number[][] = [[], [], []];
  let attackerEid = 0;

  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  function reseed(): void {
    world = createGameWorld({ seed: state.seed });
    world.state = 'playing';
    world.floorExtendedState = {
      familyState: {
        presentFamilies: FAMS.slice() as unknown as never,
        contestedResource: asFamilyId('ore') as unknown as never,
        betrayerFlag: false,
      } as never,
    };
    initializeFactionRelations(world, FAMS as unknown as never);
    // Set relations from sliders (they're stored as absolute, but the API is
    // delta-only — normalize to default first then adjust).
    for (let i = 0; i < FAMS.length; i++) {
      const target = i === 0 ? state.relA : i === 1 ? state.relB : state.relC;
      adjustFactionRelation(world, FAMS[i]!, target - getRelation(world, FAMS[i]!));
    }
    playerEid = spawnPlayer(world, state.playerX, state.playerY);
    mobsPerFamily.forEach((arr) => (arr.length = 0));
    // 3 mobs per family arranged in a rough triangle.
    const positions: [number, number][][] = [
      [
        [4, 0],
        [5, 1],
        [4, -1],
      ],
      [
        [-4, 0],
        [-5, 1],
        [-4, -1],
      ],
      [
        [0, 4],
        [1, 5],
        [-1, 4],
      ],
    ];
    for (let i = 0; i < FAMS.length; i++) {
      for (const [x, y] of positions[i]!) {
        const eid = spawnBehaviorEnemy(world, x, y, 100, AI_TYPE.CHASE, 0.1, 999, 0);
        addComponent(world.ecs, eid, set(FamilyMembership, { familyId: i, isBoss: 0 }));
        mobsPerFamily[i]!.push(eid);
      }
    }
    // An external attacker for retaliation testing.
    attackerEid = spawnBehaviorEnemy(world, 10, 10, 100, AI_TYPE.CHASE, 0.1, 999, 0);
    addComponent(world.ecs, attackerEid, set(FamilyMembership, { familyId: 1, isBoss: 0 }));
    render();
  }

  function render(): void {
    familyFeudSystem(world);
    const lines: string[] = [];
    lines.push(`Player @ (${state.playerX}, ${state.playerY})  elapsedMs=${world.elapsedMs}`);
    const retal = peekFriendlyRetaliation(world);
    lines.push(
      `Retaliation latch: ${retal ? `attacker=${retal.attackerEid} untilMs=${retal.untilMs}` : '(none)'}`,
    );
    lines.push('');
    for (let i = 0; i < FAMS.length; i++) {
      const r = getRelation(world, FAMS[i]!);
      const band = bandFor(r);
      lines.push(`${NAMES[i]} — r=${r} band=${band} (${bandColor(band)})`);
      for (const eid of mobsPerFamily[i]!) {
        const d = getFamilyAIDecision(world, eid);
        const line = d
          ? `  eid=${eid} → ${d.kind} target=${d.targetEid ?? '-'} @(${d.x.toFixed(1)},${d.y.toFixed(1)})` +
            (d.effectiveSpeed !== undefined ? ` speed=${d.effectiveSpeed.toFixed(2)}` : '') +
            ` bypass=${d.bypassPlayerDetection}`
          : `  eid=${eid} → (no override — default player targeting)`;
        lines.push(line);
      }
    }
    lines.push('');
    lines.push(
      `Tuning: leash=${tuning.factionRelations.friendlyLeashTiles} tiles, retaliationMs=${tuning.factionRelations.friendlyRetaliationMs}, feudRadius=${tuning.factionRelations.feudEngagementRadiusTiles} tiles, feudLimit=${tuning.factionRelations.feudCandidateLimit}`,
    );
    panel.textContent = lines.join('\n');
  }

  const actions = {
    reseed: () => reseed(),
    hitPlayer: () => {
      const ev: CombatEvent = {
        type: 'hit',
        x: state.playerX,
        y: state.playerY,
        amount: 5,
        targetType: 'player',
        timestamp: world.elapsedMs,
        targetEid: playerEid,
        sourceEid: attackerEid,
      };
      world.combatEvents.push(ev);
      render();
    },
    tick100ms: () => {
      world.elapsedMs += 100;
      render();
    },
    tick1s: () => {
      world.elapsedMs += 1000;
      render();
    },
    tick5s: () => {
      world.elapsedMs += 5000;
      render();
    },
    apply: () => {
      for (let i = 0; i < FAMS.length; i++) {
        const target = i === 0 ? state.relA : i === 1 ? state.relB : state.relC;
        adjustFactionRelation(world, FAMS[i]!, target - getRelation(world, FAMS[i]!));
      }
      world.stores.position.x[playerEid] = state.playerX;
      world.stores.position.y[playerEid] = state.playerY;
      render();
    },
  };

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => reseed());
  gui
    .add(state, 'playerX', -20, 20, 1)
    .name('Player X')
    .onChange(() => actions.apply());
  gui
    .add(state, 'playerY', -20, 20, 1)
    .name('Player Y')
    .onChange(() => actions.apply());
  gui
    .add(state, 'relA', 0, 100, 1)
    .name('Rel: Crawlers')
    .onChange(() => actions.apply());
  gui
    .add(state, 'relB', 0, 100, 1)
    .name('Rel: Rat Court')
    .onChange(() => actions.apply());
  gui
    .add(state, 'relC', 0, 100, 1)
    .name('Rel: Bone Choir')
    .onChange(() => actions.apply());
  gui.add(actions, 'reseed').name('↻ Reseed');
  gui.add(actions, 'hitPlayer').name('💥 Hit player (arms retaliation)');
  gui.add(actions, 'tick100ms').name('+100ms');
  gui.add(actions, 'tick1s').name('+1s');
  gui.add(actions, 'tick5s').name('+5s');

  reseed();

  return () => {
    panel.remove();
  };
}

registerLab('family-feud-lab', {
  category: 'Entities' as LabCategory,
  name: 'Family Feud Lab',
  description:
    'Floor-2 Slice 3 — inspect band-driven target selection, hate speed ramp, and friendly-ally retaliation across three feuding families.',
  create: createFamilyFeudLab,
});
