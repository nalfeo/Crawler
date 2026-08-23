import GUI from 'lil-gui';
import { query } from 'bitecs';
import { Enemy, Player, Position, createGameWorld, spawnPlayer } from '../../core/index.js';
import {
  _resolveFloor3WildSpawnWeights,
  floor3WildDirectorSystem,
  initializeFloor3Scenario,
} from '../../game/floor3Scenario.js';
import { TeamId } from '../../shared/constants.js';
import { AFFINITY_RING } from '../../shared/data/floor3/affinity.js';
import { getFloorEnemyPack } from '../../shared/enemy-packs.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createFloor3OverworldLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = {
    seed: 4242,
    steps: 1,
    playerXOffset: 0,
    playerYOffset: 0,
  };

  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  let world = createGameWorld({ seed: state.seed });
  let playerEid = -1;

  function setup(): void {
    world = createGameWorld({ seed: state.seed });
    playerEid = spawnPlayer(world, 0, 0);
    initializeFloor3Scenario(world, playerEid);
    render();
  }

  function applyOffsets(): void {
    if (!world.floorMap || playerEid < 0) return;
    const spawn = world.floorMap.tileToWorld(
      world.floorMap.playerSpawn.x,
      world.floorMap.playerSpawn.y,
    );
    world.stores.position.x[playerEid] = spawn.x + state.playerXOffset;
    world.stores.position.y[playerEid] = spawn.y + state.playerYOffset;
    render();
  }

  function tickDirector(): void {
    const pack = getFloorEnemyPack('floor3-wild');
    for (let i = 0; i < state.steps; i += 1) {
      world.elapsedMs += pack?.spawnIntervalMs ?? 1000;
      floor3WildDirectorSystem(world);
    }
    render();
  }

  function render(): void {
    if (playerEid < 0) return;
    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;
    const weights = _resolveFloor3WildSpawnWeights(world, playerX, playerY);
    const sorted = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const tile = world.floorMap?.worldToTile(playerX, playerY);
    const biomeZones = world.floorMap?.territoryZones ?? [];
    const active = biomeZones
      .map((zone) => {
        const dx = (tile?.x ?? 0) - zone.centerX;
        const dy = (tile?.y ?? 0) - zone.centerY;
        return dx * dx + dy * dy <= zone.radius * zone.radius
          ? AFFINITY_RING[zone.familyIndex]
          : null;
      })
      .filter((value): value is (typeof AFFINITY_RING)[number] => value !== null);
    const enemies = query(world.ecs, [Enemy, Position]);
    const lastEnemy = enemies.at(-1);
    const lines = [
      `seed=${state.seed} floor=${world.floorId} ambientTracked=${world.floorExtendedState?.ambientEnemyArchetypes?.size ?? 0}`,
      `player=(${playerX.toFixed(1)}, ${playerY.toFixed(1)}) tile=${tile ? `${tile.x},${tile.y}` : '-'}`,
      `activeBiomes=${active.join(', ') || '(nearest fallback only)'}`,
      `zoneCount=${biomeZones.length} wildTeam=${TeamId.ENEMY}`,
      '',
      'top spawn weights:',
      ...sorted.map(([id, probability]) => `  ${id}: ${probability.toFixed(3)}`),
      '',
      lastEnemy !== undefined
        ? `last wild eid=${lastEnemy} @ (${(world.stores.position.x[lastEnemy] ?? 0).toFixed(1)}, ${(world.stores.position.y[lastEnemy] ?? 0).toFixed(1)})`
        : 'last wild: (none spawned yet)',
      `playerEntities=${query(world.ecs, [Player]).length} enemyEntities=${enemies.length}`,
    ];
    panel.textContent = lines.join('\n');
  }

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => setup());
  gui.add(state, 'steps', 1, 6, 1).name('Spawn bursts');
  gui
    .add(state, 'playerXOffset', -120, 120, 4)
    .name('Player X offset')
    .onChange(() => applyOffsets());
  gui
    .add(state, 'playerYOffset', -120, 120, 4)
    .name('Player Y offset')
    .onChange(() => applyOffsets());
  gui.add({ reseed: () => setup() }, 'reseed').name('↻ Rebuild overworld');
  gui.add({ spawn: () => tickDirector() }, 'spawn').name('Spawn wilds');

  setup();
  return () => {
    panel.remove();
  };
}

registerLab('floor3-overworld-lab', {
  category: 'Entities' as LabCategory,
  name: 'Floor 3 Overworld Lab',
  description:
    'Floor 3 — inspect the 7-biome overworld territory layout and the affinity-weighted wild spawn director.',
  create: createFloor3OverworldLab,
});
