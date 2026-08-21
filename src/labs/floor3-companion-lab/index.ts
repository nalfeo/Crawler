/**
 * Floor 3 Companion Lab — slice 3.
 *
 * Text-mode sandbox for the team-tagged companion AI prepass:
 * - rival targeting (different team id),
 * - player follow outside leash,
 * - idle inside leash.
 */
import GUI from 'lil-gui';
import { addComponent, set } from 'bitecs';
import {
  Companion,
  Team,
  createGameWorld,
  spawnBehaviorEnemy,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { AI_TYPE, companionAISystem, getCompanionAIDecision } from '../../game/index.js';
import { TeamId } from '../../shared/constants.js';
import tuning from '../../shared/data/tuning.json';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createFloor3CompanionLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const state = {
    seed: 30303,
    playerX: 0,
    playerY: 0,
    companionX: 12,
    companionY: 0,
    rivalX: 4,
    rivalY: 0,
    spawnRival: true,
    companionKnockedOut: false,
  };

  const panel = document.createElement('pre');
  panel.style.cssText =
    'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:640px;white-space:pre;';
  canvasHost.append(panel);

  let world: GameWorld = createGameWorld({ seed: state.seed });
  let playerEid = -1;
  let companionEid = -1;
  let rivalEid = -1;

  function reseed(): void {
    world = createGameWorld({ seed: state.seed });
    playerEid = spawnPlayer(world, state.playerX, state.playerY);
    companionEid = spawnBehaviorEnemy(
      world,
      state.companionX,
      state.companionY,
      100,
      AI_TYPE.CHASE,
      0.12,
      999,
      0,
    );
    addComponent(world.ecs, companionEid, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companionEid,
      set(Companion, {
        speciesToken: 1,
        form: 0,
        level: 1,
        xp: 0,
        ownerTeam: TeamId.PLAYER,
        knockedOut: state.companionKnockedOut ? 1 : 0,
      }),
    );
    if (state.spawnRival) {
      rivalEid = spawnBehaviorEnemy(
        world,
        state.rivalX,
        state.rivalY,
        100,
        AI_TYPE.CHASE,
        0.12,
        999,
        0,
      );
      addComponent(world.ecs, rivalEid, set(Team, { id: TeamId.ENEMY }));
    } else {
      rivalEid = -1;
    }
    render();
  }

  function applyState(): void {
    if (playerEid >= 0) {
      world.stores.position.x[playerEid] = state.playerX;
      world.stores.position.y[playerEid] = state.playerY;
    }
    if (companionEid >= 0) {
      world.stores.position.x[companionEid] = state.companionX;
      world.stores.position.y[companionEid] = state.companionY;
      world.stores.companion.knockedOut[companionEid] = state.companionKnockedOut ? 1 : 0;
    }
    if (rivalEid >= 0) {
      world.stores.position.x[rivalEid] = state.rivalX;
      world.stores.position.y[rivalEid] = state.rivalY;
    }
    render();
  }

  function render(): void {
    companionAISystem(world);
    const decision = companionEid >= 0 ? getCompanionAIDecision(world, companionEid) : undefined;
    const lines: string[] = [];
    lines.push(`player eid=${playerEid} @ (${state.playerX}, ${state.playerY})`);
    lines.push(`companion eid=${companionEid} @ (${state.companionX}, ${state.companionY})`);
    lines.push(
      state.spawnRival
        ? `rival eid=${rivalEid} @ (${state.rivalX}, ${state.rivalY})`
        : 'rival: (not spawned)',
    );
    lines.push(
      `leash=${tuning.factionRelations.friendlyLeashTiles}, companionKnockedOut=${state.companionKnockedOut}`,
    );
    lines.push('');
    if (decision === undefined) {
      lines.push('decision: (none)');
    } else {
      lines.push(
        `decision: ${decision.kind} target=${decision.targetEid ?? '-'} @(${decision.x.toFixed(2)}, ${decision.y.toFixed(2)}) bypass=${decision.bypassPlayerDetection}`,
      );
    }
    panel.textContent = lines.join('\n');
  }

  gui
    .add(state, 'seed')
    .name('Seed')
    .onFinishChange(() => reseed());
  gui
    .add(state, 'playerX', -20, 20, 1)
    .name('Player X')
    .onChange(() => applyState());
  gui
    .add(state, 'playerY', -20, 20, 1)
    .name('Player Y')
    .onChange(() => applyState());
  gui
    .add(state, 'companionX', -20, 20, 1)
    .name('Companion X')
    .onChange(() => applyState());
  gui
    .add(state, 'companionY', -20, 20, 1)
    .name('Companion Y')
    .onChange(() => applyState());
  gui
    .add(state, 'rivalX', -20, 20, 1)
    .name('Rival X')
    .onChange(() => applyState());
  gui
    .add(state, 'rivalY', -20, 20, 1)
    .name('Rival Y')
    .onChange(() => applyState());
  gui
    .add(state, 'spawnRival')
    .name('Spawn rival')
    .onChange(() => reseed());
  gui
    .add(state, 'companionKnockedOut')
    .name('Companion KO')
    .onChange(() => applyState());
  gui.add({ reseed: () => reseed() }, 'reseed').name('↻ Reseed');

  reseed();
  return () => {
    panel.remove();
  };
}

registerLab('floor3-companion-lab', {
  category: 'Entities' as LabCategory,
  name: 'Floor 3 Companion Lab',
  description: 'Floor 3 Slice 3 — inspect companion team-targeting, follow, and idle decisions.',
  create: createFloor3CompanionLab,
});
