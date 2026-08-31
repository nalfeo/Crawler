import GUI from 'lil-gui';
import { query } from 'bitecs';
import { Companion, createGameWorld, Enemy, spawnPlayer, Team } from '../../core/index.js';
import {
  arenaDirectorSystem,
  getFloor4LiveWaveEnemyCount,
  initializeFloor4Scenario,
} from '../../game/floor4Scenario.js';
import {
  capturePlayerCarryover,
  type PlayerCarryoverSnapshot,
} from '../../game/playerCarryover.js';
import { TeamId } from '../../shared/constants.js';
import { buildKeptCompanionContract } from '../../shared/data/floor3/kept-companion-contract.js';
import {
  getPetSpecies,
  loadPetSpecies,
  speciesForToken,
} from '../../shared/data/floor3/species.js';
import { getFloorManifest } from '../../shared/floor-registry.js';
import {
  buildFloor4ActWaveManifests,
  type Floor4WaveScheduleConfig,
} from '../../shared/floor4-waves.js';
import type { Floor4ActIndex } from '../../shared/floor-types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

/**
 * Mutable view of the authored wave block.
 *
 * The lab hot-patches the in-memory manifest so the SAME numbers drive both the
 * manifest preview and the live director — a preview that reads different
 * values than the running arena is how a tuning session ends up lying. The
 * authored block is restored on teardown, so no other lab inherits the edits.
 */
interface MutableWaveConfig {
  cadence: { wavesPerAct: number; intervalMs: number };
  budget: {
    base: number;
    actMultipliers: number[];
    intraActRamp: number;
    openingWaveMultiplier: number;
    maxEntriesPerWave: number;
  };
  concurrency: { liveCap: number; debtCap: number };
  gates: { telegraphLeadMs: number };
}

/** The venue always authors four feed gates (one per arena wall). */
const GATE_COUNT = 4;

function createFloor4ArenaLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const floor4 = getFloorManifest('floor4')!.floor4!;
  const phase = floor4.phase;
  const waves = floor4.waves as unknown as MutableWaveConfig;
  const authoredWaves = structuredClone(waves);

  const state = {
    seed: 404,
    stepMs: 1_000,
    previewAct: 1,
    wavesPerAct: waves.cadence.wavesPerAct,
    intervalMs: waves.cadence.intervalMs,
    budgetBase: waves.budget.base,
    intraActRamp: waves.budget.intraActRamp,
    openingWaveMultiplier: waves.budget.openingWaveMultiplier,
    actMultiplier: waves.budget.actMultipliers[0]!,
    liveCap: waves.concurrency.liveCap,
    debtCap: waves.concurrency.debtCap,
    telegraphLeadMs: waves.gates.telegraphLeadMs,
    includeKeptCompanion: false,
    keptCompanionSpeciesId: 'ember-charger',
  };

  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  let world = createGameWorld({ seed: state.seed });

  function applyTunables(): void {
    waves.cadence.wavesPerAct = state.wavesPerAct;
    waves.cadence.intervalMs = state.intervalMs;
    waves.budget.base = state.budgetBase;
    waves.budget.intraActRamp = state.intraActRamp;
    waves.budget.openingWaveMultiplier = state.openingWaveMultiplier;
    waves.budget.actMultipliers[state.previewAct - 1] = state.actMultiplier;
    waves.concurrency.liveCap = state.liveCap;
    waves.concurrency.debtCap = state.debtCap;
    waves.gates.telegraphLeadMs = state.telegraphLeadMs;
    setup();
  }

  function setup(): void {
    world = createGameWorld({ seed: state.seed });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor4Scenario(world, player, buildLabCarryover(player));
    render();
  }

  function buildLabCarryover(
    player: number,
  ): { playerCarryover: PlayerCarryoverSnapshot } | undefined {
    if (!state.includeKeptCompanion) {
      return undefined;
    }
    const base = capturePlayerCarryover(world, player);
    const species = getPetSpecies(state.keptCompanionSpeciesId);
    if (!species) {
      throw new Error(`Unknown Floor 3 species: ${state.keptCompanionSpeciesId}`);
    }
    return {
      playerCarryover: {
        ...base,
        keptCompanion: buildKeptCompanionContract(species),
      },
    };
  }

  function step(): void {
    world.elapsedMs += state.stepMs;
    arenaDirectorSystem(world);
    render();
  }

  function previewLines(): string[] {
    const manifests = buildFloor4ActWaveManifests(
      floor4.waves as Floor4WaveScheduleConfig,
      state.seed,
      state.previewAct as Floor4ActIndex,
      GATE_COUNT,
    );
    return manifests.map((manifest) => {
      const perGate = new Map<number, number>();
      for (const entry of manifest.entries) {
        perGate.set(entry.gateIndex, (perGate.get(entry.gateIndex) ?? 0) + 1);
      }
      const gates = [...perGate.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([gate, count]) => `g${gate}×${count}`)
        .join(' ');
      return (
        `  w${manifest.waveIndex} @${(manifest.releaseAtActMs / 1000).toFixed(1)}s ` +
        `budget=${manifest.budget.toFixed(2)} entries=${manifest.entries.length} ${gates}`
      );
    });
  }

  function render(): void {
    const arena = world.floorExtendedState?.floor4Arena;
    const window = arena?.waves;
    const telemetry = arena?.waveTelemetry;
    const coStars = [...query(world.ecs, [Enemy, Companion, Team])].filter(
      (eid) => world.stores.team.id[eid] === TeamId.PLAYER,
    );
    const coStarSpecies = coStars
      .map((eid) => speciesForToken(world.stores.companion.speciesToken[eid] ?? 0)?.speciesId)
      .filter((speciesId): speciesId is string => speciesId !== undefined);
    const lines = [
      `seed=${state.seed} floor=${world.floorId || '(not initialized)'}`,
      `worldElapsedMs=${world.elapsedMs}`,
      `phase=${arena ? JSON.stringify(arena.phase) : '(none)'}`,
      `arenaElapsedMs=${arena?.arenaElapsedMs ?? 0} phaseElapsedMs=${arena?.phaseElapsedMs ?? 0}`,
      `keptCompanion=${state.includeKeptCompanion ? state.keptCompanionSpeciesId : '(none)'} liveCoStars=${coStars.length}${coStarSpecies.length > 0 ? ` [${coStarSpecies.join(', ')}]` : ''}`,
      '',
      'live wave window:',
      `  waves=${window ? window.releaseCursor : 0}/${window?.manifests.length ?? 0}` +
        ` live=${getFloor4LiveWaveEnemyCount(world)}/${state.liveCap}` +
        ` debt=${window?.debt.length ?? 0}/${state.debtCap}` +
        ` armedGates=${window?.armedTelegraphs.length ?? 0}`,
      `  spawned=${telemetry?.enemiesSpawned ?? 0} cut=${telemetry?.enemiesCut ?? 0}` +
        ` discarded=${telemetry?.debtDiscarded ?? 0} lit=${telemetry?.gateTelegraphsArmed ?? 0}`,
      '',
      `act ${state.previewAct} manifest preview (seed ${state.seed}):`,
      ...previewLines(),
      '',
      'timeline:',
      ...(arena?.timeline ?? []).map(
        (entry) =>
          `  f=${entry.frame} world=${entry.worldElapsedMs} arena=${entry.arenaElapsedMs} ${JSON.stringify(entry.phase)} ${entry.reason}`,
      ),
    ];
    panel.textContent = lines.join('\n');
  }

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => setup());
  gui.add(state, 'stepMs', 16, phase.actDurationMs, 16).name('Step ms');
  gui.add({ step }, 'step').name('Advance director');

  const waveFolder = gui.addFolder('Waves');
  waveFolder
    .add(state, 'previewAct', 1, phase.actCount, 1)
    .name('Preview act')
    .onChange(() => {
      state.actMultiplier = waves.budget.actMultipliers[state.previewAct - 1]!;
      render();
    });
  waveFolder.add(state, 'wavesPerAct', 1, 16, 1).name('Waves / act').onFinishChange(applyTunables);
  waveFolder
    .add(state, 'intervalMs', 1_000, 30_000, 500)
    .name('Wave interval ms')
    .onFinishChange(applyTunables);
  waveFolder.add(state, 'budgetBase', 1, 40, 0.5).name('Budget base').onFinishChange(applyTunables);
  waveFolder
    .add(state, 'actMultiplier', 0.5, 8, 0.05)
    .name('Act multiplier')
    .onFinishChange(applyTunables);
  waveFolder
    .add(state, 'intraActRamp', 0, 0.5, 0.01)
    .name('Intra-act ramp')
    .onFinishChange(applyTunables);
  waveFolder
    .add(state, 'openingWaveMultiplier', 0.05, 1, 0.01)
    .name('Opening wave ×')
    .onFinishChange(applyTunables);
  waveFolder.add(state, 'liveCap', 1, 64, 1).name('Live cap').onFinishChange(applyTunables);
  waveFolder.add(state, 'debtCap', 0, 64, 1).name('Debt cap').onFinishChange(applyTunables);
  waveFolder
    .add(state, 'telegraphLeadMs', 0, 5_000, 50)
    .name('Gate telegraph ms')
    .onFinishChange(applyTunables);

  const coStarFolder = gui.addFolder('Kept companion co-star');
  coStarFolder.add(state, 'includeKeptCompanion').name('Include co-star').onChange(setup);
  coStarFolder
    .add(
      state,
      'keptCompanionSpeciesId',
      loadPetSpecies().map((species) => species.speciesId),
    )
    .name('Species')
    .onChange(setup);

  gui.add({ reset: setup }, 'reset').name('Reset');

  setup();
  return () => {
    // Restore the authored block: the hot-patch above is lab-only.
    waves.cadence = authoredWaves.cadence;
    waves.budget = authoredWaves.budget;
    waves.concurrency = authoredWaves.concurrency;
    waves.gates = authoredWaves.gates;
    panel.remove();
  };
}

registerLab('floor4-arena-lab', {
  category: 'Progression' as LabCategory,
  name: 'Floor 4 Arena Lab',
  description:
    'Floor 4 — phase machine, arena clock, and the deterministic wave schedule (budget curve, gates, live cap, spawn debt, the cut).',
  create: createFloor4ArenaLab,
});
