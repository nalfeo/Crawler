/**
 * Floor 3 Companion Lab — slices 3–6.
 *
 * Text-mode sandbox for:
 * - rival targeting (different team id), player follow/idle leash,
 * - Guardian / Support persona movement through the real AI → movement pipeline (slice 4),
 * - combat-XP attribution, evolution, and ability unlocks via the real
 *   `companionCombatSystem` → `applyDamage` → `companionProgressionSystem`
 *   pipeline (slice 5),
 * - the real KO/recovery state machine, Rally Point instant recovery, and the
 *   party-wipe predicate via `companionKOSystem` (slice 6).
 */
import GUI from 'lil-gui';
import { addComponent, set } from 'bitecs';
import {
  Companion,
  PartySlot,
  Team,
  companionKOSystem,
  companionLearnedAbilityIds,
  companionProgressionSystem,
  createGameWorld,
  _isPartyWiped,
  movementSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
  spawnRallyPoint,
  type GameWorld,
} from '../../core/index.js';
import {
  AI_TYPE,
  companionAISystem,
  companionCombatSystem,
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
import { getFloorEnemyPack } from '../../shared/enemy-packs.js';
import { xpRequiredForLevel } from '../../shared/xpMath.js';
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
    rivalX: 2,
    rivalY: 0,
    spawnRival: true,
    companionKnockedOut: false,
    aiType: 'GUARDIAN' as LabAiType,
    // Floor-3-ONLY companion-buff tunables (human-authorized, session
    // 2026-09-03) — defaults mirror `tuning.floor3Companion` so the lab
    // starts in sync with production, but every slider below is editable
    // here to explore the effect before/instead of editing tuning.json.
    starterCompanionLevel: tuning.floor3Companion.starterLevel,
    playerCompanionHpMultiplier: tuning.floor3Companion.playerCompanionHpMultiplier,
    playerCompanionDamageMultiplier: tuning.floor3Companion.playerCompanionDamageMultiplier,
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
    world.floorId = 'floor3';
    playerEid = spawnPlayer(world, state.playerX, state.playerY);
    const species = getPetSpecies('ember-charger');
    const archetype = getFloorEnemyPack('floor3-wild')?.archetypes.find(
      (candidate) => candidate.speciesId === species?.speciesId,
    );
    if (species === undefined || archetype === undefined) {
      throw new Error('Floor 3 companion lab requires the ember-charger wild archetype.');
    }
    const form = formForLevel(species, state.starterCompanionLevel);
    // Mirror `recruitFloor3PartyCompanion` exactly: wild-pack base HP, current
    // form scale, then the player-party-only tuning multiplier.
    const companionHp = Math.max(
      1,
      Math.round(archetype.hp * form.statScale * state.playerCompanionHpMultiplier),
    );
    companionEid = spawnBehaviorEnemy(
      world,
      state.companionX,
      state.companionY,
      companionHp,
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
        form: form.form,
        level: state.starterCompanionLevel,
        xp: xpRequiredForLevel(Math.max(0, state.starterCompanionLevel - 1)),
        ownerTeam: TeamId.PLAYER,
        knockedOut: state.companionKnockedOut ? 1 : 0,
      }),
    );
    // The wipe predicate (`_isPartyWiped`) only counts recruited party members,
    // i.e. Companions carrying a `PartySlot` (see `recruitPartyCompanion`).
    // Attach one here so the lab's "party wiped" panel actually reflects the
    // predicate instead of reading a permanent `false`.
    addComponent(world.ecs, companionEid, set(PartySlot, { slot: 0, locked: 0 }));
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
    companionAISystem(world);
    companionCombatSystem(world, state.playerCompanionDamageMultiplier);
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
      lines.push('Floor-3-ONLY companion buff (human-authorized 2026-09-03):');
      lines.push(
        `  starterCompanionLevel=${state.starterCompanionLevel} ` +
          `hpMultiplier=${state.playerCompanionHpMultiplier}x ` +
          `damageMultiplier=${state.playerCompanionDamageMultiplier}x`,
      );
      lines.push(
        `  tuning.json defaults: starterLevel=${tuning.floor3Companion.starterLevel} ` +
          `hpMultiplier=${tuning.floor3Companion.playerCompanionHpMultiplier}x ` +
          `damageMultiplier=${tuning.floor3Companion.playerCompanionDamageMultiplier}x`,
      );
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
      lines.push(`  party wiped (_isPartyWiped)=${_isPartyWiped(world, TeamId.PLAYER)}`);
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
  gui
    .add(state, 'starterCompanionLevel', 1, 34, 1)
    .name('Floor3: starter level')
    .onChange(() => reseed());
  gui
    .add(state, 'playerCompanionHpMultiplier', 0.5, 10, 0.5)
    .name('Floor3: companion HP x')
    .onChange(() => reseed());
  gui.add(state, 'playerCompanionDamageMultiplier', 0.5, 10, 0.5).name('Floor3: companion dmg x');
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
    'Floor 3 — inspect companion targeting, Guardian/Support persona movement, slice-5 combat-XP/evolution/ability progression, slice-6 KO/recovery + Rally Point, and the Floor-3-only starter level / companion HP+damage buff multipliers used to make production Floor 3 completable.',
  create: createFloor3CompanionLab,
});
