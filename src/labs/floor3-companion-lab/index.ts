/**
 * Floor 3 Companion Lab — slices 3–6.
 *
 * Text-mode sandbox for:
 * - rival targeting (different team id), player follow/idle leash,
 * - Guardian / Support persona movement through the real AI → movement pipeline (slice 4),
 * - combat-XP attribution, evolution, and ability unlocks via the real
 *   `applyDamage` → `companionProgressionSystem` pipeline (slice 5),
 * - the real KO/recovery state machine, Rally Point instant recovery, and the
 *   party-wipe predicate via `companionKOSystem` (slice 6).
 */
import GUI from 'lil-gui';
import { addComponent, set } from 'bitecs';
import {
  Companion,
  Team,
  applyDamage,
  companionKOSystem,
  companionLearnedAbilityIds,
  companionProgressionSystem,
  createGameWorld,
  isPartyWiped,
  movementSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
  spawnRallyPoint,
  type GameWorld,
} from '../../core/index.js';
import {
  AI_TYPE,
  companionAISystem,
  enemyAISystem,
  getCompanionAIDecision,
} from '../../game/index.js';
import { TeamId } from '../../shared/constants.js';
import {
  formForLevel,
  getPetSpecies,
  speciesTokenForId,
} from '../../shared/data/floor3/species.js';
import tuning from '../../shared/data/tuning.json';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type LabAiType = 'CHASE' | 'GUARDIAN' | 'SUPPORT';

function labAiTypeValue(type: LabAiType): number {
  return AI_TYPE[type];
}

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
    aiType: 'GUARDIAN' as LabAiType,
    attackDamage: 6,
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
      labAiTypeValue(state.aiType),
      0.12,
      999,
      state.aiType === 'SUPPORT' ? 12 : 0,
    );
    addComponent(world.ecs, companionEid, set(Team, { id: TeamId.PLAYER }));
    addComponent(
      world.ecs,
      companionEid,
      set(Companion, {
        speciesToken: speciesTokenForId('ember-charger'),
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

  function attackRival(): void {
    if (companionEid < 0 || rivalEid < 0) return;
    const rivalX = world.stores.position.x[rivalEid] ?? 0;
    const rivalY = world.stores.position.y[rivalEid] ?? 0;
    applyDamage(world, rivalEid, state.attackDamage, rivalX, rivalY, {
      origin: 'enemy',
      affinity: 'physical',
      scaleWithPrimary: false,
      canCrit: false,
      sourceEid: companionEid,
    });
    companionProgressionSystem(world);
    render();
  }

  function koCompanionNow(): void {
    if (companionEid < 0) return;
    world.stores.health.current[companionEid] = 0;
    companionKOSystem(world);
    render();
  }

  function advanceFrames(count: number): void {
    for (let i = 0; i < count; i++) {
      world.frameCount += 1;
      companionKOSystem(world);
    }
    render();
  }

  function placeRallyPoint(): void {
    if (playerEid < 0) return;
    spawnRallyPoint(
      world,
      world.stores.position.x[playerEid] ?? 0,
      world.stores.position.y[playerEid] ?? 0,
    );
    companionKOSystem(world);
    render();
  }

  function render(): void {
    const beforeX = companionEid >= 0 ? (world.stores.position.x[companionEid] ?? 0) : 0;
    const beforeY = companionEid >= 0 ? (world.stores.position.y[companionEid] ?? 0) : 0;
    companionAISystem(world);
    enemyAISystem(world);
    movementSystem(world);
    const decision = companionEid >= 0 ? getCompanionAIDecision(world, companionEid) : undefined;
    const afterX = companionEid >= 0 ? (world.stores.position.x[companionEid] ?? 0) : 0;
    const afterY = companionEid >= 0 ? (world.stores.position.y[companionEid] ?? 0) : 0;
    const velocityX = companionEid >= 0 ? (world.stores.velocity.x[companionEid] ?? 0) : 0;
    const velocityY = companionEid >= 0 ? (world.stores.velocity.y[companionEid] ?? 0) : 0;
    const lines: string[] = [];
    lines.push(`player eid=${playerEid} @ (${state.playerX}, ${state.playerY})`);
    lines.push(`companion eid=${companionEid} ai=${state.aiType}`);
    lines.push(
      `companion step: (${beforeX.toFixed(2)}, ${beforeY.toFixed(2)}) -> (${afterX.toFixed(2)}, ${afterY.toFixed(2)})`,
    );
    lines.push(`velocity: (${velocityX.toFixed(3)}, ${velocityY.toFixed(3)})`);
    lines.push(
      state.spawnRival
        ? `rival eid=${rivalEid} @ (${state.rivalX}, ${state.rivalY}) hp=${(world.stores.health.current[rivalEid] ?? 0).toFixed(0)}/${(world.stores.health.max[rivalEid] ?? 0).toFixed(0)}`
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
    lines.push('');
    if (companionEid >= 0) {
      const level = world.stores.companion.level[companionEid] ?? 0;
      const xp = world.stores.companion.xp[companionEid] ?? 0;
      const form = world.stores.companion.form[companionEid] ?? 0;
      const species = getPetSpecies('ember-charger');
      const formName = species ? formForLevel(species, level).name : '?';
      const abilities = companionLearnedAbilityIds(world, companionEid);
      lines.push(`slice 5 — companion progression (ember-charger):`);
      lines.push(`  level=${level} xp=${xp.toFixed(1)} form=${form} (${formName})`);
      lines.push(`  abilities learned: ${abilities.join(', ')}`);
      lines.push('');
      const knockedOut = (world.stores.companion.knockedOut[companionEid] ?? 0) === 1;
      const idleSince = world.companionEngagementIdleSince.get(TeamId.PLAYER);
      lines.push(`slice 6 — KO/recovery (frame=${world.frameCount}):`);
      lines.push(
        `  companion hp=${(world.stores.health.current[companionEid] ?? 0).toFixed(0)}/${(world.stores.health.max[companionEid] ?? 0).toFixed(0)} knockedOut=${knockedOut}`,
      );
      lines.push(
        `  idleSinceFrame=${idleSince ?? '-'} engagementEndFrames=${tuning.floor3Companion.engagementEndFrames}`,
      );
      lines.push(`  party wiped (isPartyWiped)=${isPartyWiped(world, TeamId.PLAYER)}`);
    }
    panel.textContent = lines.join('\n');
  }

  gui
    .add(state, 'aiType', ['CHASE', 'GUARDIAN', 'SUPPORT'])
    .name('Companion AI')
    .onChange(() => reseed());
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
  gui.add(state, 'attackDamage', 1, 100, 1).name('Attack damage');
  gui.add({ attack: () => attackRival() }, 'attack').name('⚔ Companion attacks rival');
  gui.add({ koNow: () => koCompanionNow() }, 'koNow').name('💥 KO companion now');
  gui.add({ advance60: () => advanceFrames(60) }, 'advance60').name('⏱ Advance 60 frames (~1s)');
  gui.add({ rally: () => placeRallyPoint() }, 'rally').name('🏳 Place Rally Point at player');
  gui.add({ reseed: () => reseed() }, 'reseed').name('↻ Reseed');

  reseed();
  return () => {
    panel.remove();
  };
}

registerLab('floor3-companion-lab', {
  category: 'Entities' as LabCategory,
  name: 'Floor 3 Companion Lab',
  description:
    'Floor 3 — inspect companion targeting, Guardian/Support persona movement, slice-5 combat-XP/evolution/ability progression, and slice-6 KO/recovery + Rally Point.',
  create: createFloor3CompanionLab,
});
