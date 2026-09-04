import GUI from 'lil-gui';
import { createGameWorld, spawnPlayer } from '../../core/index.js';
import { createFloorMainSceneOptions } from '../../bootstrap/floor-main-scene-options.js';
import { runSimulationStep } from '../../game/ai/simulation-step.js';
import { getFloor5SiegeRunStats, requestFloor5ThroneCapture } from '../../game/floor5Scenario.js';
import { GAME } from '../../shared/constants.js';
import { createInputState } from '../../shared/input.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createFloor5SiegeLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = { seed: 505, stepMs: 1_000 };
  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  const sceneOptions = createFloorMainSceneOptions('floor5');
  const inputState = createInputState();
  let world = createGameWorld({ seed: state.seed });
  let lastCaptureResult: string = '(none)';

  function setup(): void {
    world = createGameWorld({ seed: state.seed });
    lastCaptureResult = '(none)';
    const player = spawnPlayer(world, 0, 0);
    sceneOptions.configureWorld!(world, player);
    render();
  }

  function step(): void {
    const steps = Math.max(1, Math.round(state.stepMs / GAME.DELTA_MS));
    for (let index = 0; index < steps; index += 1) {
      runSimulationStep(world, inputState, GAME.DELTA_MS, {
        preSystems: sceneOptions.preSystems,
        postSystems: sceneOptions.postSystems,
      });
    }
    render();
  }

  function render(): void {
    const siege = getFloor5SiegeRunStats(world);
    panel.textContent = [
      `seed=${state.seed} floor=${world.floorId || '(not initialized)'}`,
      `worldElapsedMs=${world.elapsedMs}`,
      `phase=${siege ? JSON.stringify(siege.phase) : '(none)'}`,
      `commandPostHealth=${siege?.commandPostHealth ?? 0}`,
      `engine=${siege?.engineState ?? '(none)'}`,
      `breach=${siege?.breachState ?? '(none)'}`,
      `ramHp=${siege?.ram.health ?? 0}/${siege?.ram.maxHealth ?? 0} route=${siege?.ram.routeIndex ?? 0} strikes=${siege?.ram.strikes ?? 0}`,
      `ramProtection=${siege?.ram.protectionMet ?? false} escorts=${siege?.ram.escorts ?? 0} threats=${siege?.ram.threats ?? 0}`,
      `ramRoute=${siege?.ram.routeReached.join(' -> ') || '(none)'}`,
      `ramStates=${siege?.ram.stateSequence.join(' -> ') || '(none)'}`,
      `construction=${siege?.construction.progressMs ?? 0}/${siege?.construction.requiredMs ?? 0} paused=${siege?.construction.pausedMs ?? 0} underAttack=${siege?.construction.buildSiteUnderAttack ?? false}`,
      `breachLatched=${siege?.breach.latched ?? false} frontFrozen=${siege?.breach.frontFrozen ?? false} cleanup=${JSON.stringify(siege?.breach.cleanup ?? {})}`,
      `hero=${siege?.heroState ?? '(none)'}`,
      `heroSlot=${siege?.heroes.status ?? '(none)'} cursor=${siege?.heroes.cursor ?? -1}`,
      `heroActive=${siege?.heroes.activeHeroId ?? '(none)'} role=${siege?.heroes.activeRole ?? '(none)'}`,
      `heroHp=${siege?.heroes.health ?? 0}/${siege?.heroes.maxHealth ?? 0} target=${siege?.heroes.targetEid ?? 0}`,
      `heroFrames spawned=${siege?.heroes.spawnedFrame ?? '-'} defeated=${siege?.heroes.defeatedFrame ?? '-'} respawn=${siege?.heroes.respawnFrame ?? '-'}`,
      `heroTotals spawns=${siege?.heroes.spawns ?? 0} defeats=${siege?.heroes.defeats ?? 0} abilityCasts=${siege?.heroes.abilityCasts ?? 0} buildStallMs=${siege?.heroes.buildStallMs ?? 0}`,
      `heroCard=${(siege?.heroes.card ?? []).map((entry) => `${entry.order}:${entry.heroId}(${entry.role})`).join(' -> ') || '(none)'}`,
      `checkpointOwner=${siege?.checkpointOwner ?? '(none)'}`,
      `waveCycles=${siege?.laneTelemetry.waveCyclesCompleted ?? 0}`,
      `checkpointContests=${siege?.laneTelemetry.checkpointContests ?? 0}`,
      `legalDamage=${siege?.laneTelemetry.legalDamageEvents ?? 0}`,
      `illegalDamage=${siege?.laneTelemetry.illegalDamageEvents ?? 0}`,
      `pathStalls=${siege?.laneTelemetry.pathStalls ?? 0}`,
      `courtyard entered=${siege?.finale.courtyardEnteredFrame ?? '-'} cleared=${siege?.finale.courtyardCleared ?? false}@${siege?.finale.courtyardClearedFrame ?? '-'}`,
      `auditor hp=${siege?.finale.auditorHealth ?? 0}/${siege?.finale.auditorMaxHealth ?? 0} defeated=${siege?.finale.auditorDefeatedFrame ?? '-'}`,
      `defenders ${siege?.finale.defendersDefeated ?? 0}/${siege?.finale.defendersSpawned ?? 0} defeated`,
      `throneDoor open=${siege?.finale.throneDoorOpen ?? false}@${siege?.finale.throneDoorOpenedFrame ?? '-'}`,
      `regent hp=${siege?.finale.regentHealth ?? 0}/${siege?.finale.regentMaxHealth ?? 0} spawned=${siege?.finale.regentSpawnedFrame ?? '-'} defeated=${siege?.finale.regentDefeatedFrame ?? '-'}`,
      `summons telegraphed=${siege?.finale.summonsTelegraphed ?? 0} pending=${siege?.finale.pendingSummonWaves ?? 0} released=${siege?.finale.summonsReleased ?? 0}/${siege?.finale.summonCap ?? 0} live=${siege?.finale.liveSummons ?? 0} retired=${siege?.finale.summonsRetired ?? 0}`,
      `capture available=${siege?.finale.captureAvailable ?? false}@${siege?.finale.captureAvailableFrame ?? '-'} attempts=${siege?.finale.captureAttempts ?? 0} rejected=${siege?.finale.rejectedCaptureAttempts ?? 0}`,
      `captured=${siege?.finale.captured ?? false}@${siege?.finale.capturedFrame ?? '-'} royalAuthorityDisabled=${siege?.finale.royalAuthorityDisabled ?? false} hostilesCleared=${siege?.finale.hostilesClearedOnCapture ?? 0}`,
      `balcony open=${siege?.finale.balconyOpen ?? false}@${siege?.finale.balconyOpenedFrame ?? '-'}`,
      `lastCaptureRequest=${lastCaptureResult}`,
      '',
      'stream keys:',
      ...Object.entries(siege?.rngStreamKeys ?? {}).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'structures:',
      ...Object.values(siege?.structures ?? {}).map(
        (structure) =>
          `  ${structure.id} team=${structure.team} hp=${structure.health}/${structure.maxHealth}`,
      ),
      '',
      'wave manifest:',
      ...(siege?.waveManifest ?? []).map(
        (entry) =>
          `  ${entry.id} team=${entry.team} releaseFrame=${entry.releaseFrame} count=${entry.count}`,
      ),
      '',
      'phase trace:',
      ...(siege?.trace ?? []).map(
        (entry) =>
          `  f=${entry.frame} world=${entry.worldElapsedMs} ${JSON.stringify(entry.phase)} ${entry.reason}`,
      ),
    ].join('\n');
  }

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => setup());
  gui.add(state, 'stepMs', 16, 10_000, 16).name('Step ms');
  gui.add({ step }, 'step').name('Advance siege');
  gui
    .add(
      {
        capture: () => {
          lastCaptureResult = requestFloor5ThroneCapture(world);
          render();
        },
      },
      'capture',
    )
    .name('Request throne capture');
  gui.add({ setup }, 'setup').name('Reset');

  setup();

  return () => {
    gui.destroy();
    panel.remove();
  };
}

registerLab('floor5-siege-lab', {
  name: 'Floor 5 Siege',
  category: 'Meta',
  description: 'Inspect Floor 5 siege actors, Ratings Ram lifecycle, breach cleanup, and trace.',
  create: createFloor5SiegeLab,
});
