/**
 * Generic mob-ability executor + registration API.
 *
 * Drives a deterministic per-caster phase machine
 * (`cooldown -> telegraph -> resolution -> cooldown`) for every registered
 * {@link MobAbilityRuntimeDefinition}, independent of which mob owns it. It
 * commits target/origin/geometry ONCE at telegraph start, emits the
 * announcement exactly once per cast, publishes committed cue state for the
 * renderer, and calls the ability's named resolve handler at resolution.
 *
 * Safety boundary: nothing happens unless the runtime is explicitly `enabled`
 * AND the encounter is explicitly active. The production game leaves both off
 * and registers no definitions, so it emits zero casts/events (verified by
 * test). Ability clocks only begin at the explicit encounter-active transition,
 * never at spawn/initialization.
 *
 * Cleanup: death, despawn, encounter disable, recycled ids, and invalid targets
 * all release the caster's instance, its cue, and any status effects it owns.
 */

import { entityExists, hasComponent, query } from 'bitecs';
import { GAME } from '../../shared/constants.js';
import { Health, Player, Position } from '../components.js';
import { clearStatusEffects } from '../status-effects.js';
import { pushAnnouncement } from '../../shared/announcement-events.js';
import type { GameWorld } from '../world.js';
import {
  mobAbilitySourceId,
  type MobAbilityInstanceState,
  type MobAbilityRuntimeDefinition,
} from './types.js';

/** Duration the arena/HUD banner shows a cast announcement (ms). */
const ANNOUNCEMENT_DURATION_MS = 2200;

/**
 * Phase-boundary epsilon (ms). Phase timers are exact multiples of the fixed
 * step, so the intended trigger frame lands on `timerMs === 0`. Repeated
 * float subtraction can leave a sub-nanosecond positive residual there; this
 * epsilon absorbs it so the cast fires on the intended deterministic frame
 * (never a step early — a full step is ~16.7ms, far above epsilon). This is the
 * single "simulation-step boundary" allowance the spec calls out.
 */
const TIMER_EPSILON_MS = 1e-6;

/**
 * Register `definition` as an active ability owned by `casterEid`. Idempotent:
 * re-registering the same caster resets its clock to the first-eligibility
 * cooldown. Registration alone does nothing until the runtime is enabled and
 * the encounter is active.
 */
export function registerMobAbility(
  world: GameWorld,
  casterEid: number,
  definition: MobAbilityRuntimeDefinition,
): void {
  // Re-registering an eid first releases any prior instance's cue + owned
  // effects, so a recycled/re-used caster slot can never inherit stale
  // telegraph cues or lingering debuffs from a previous registration.
  if (world.mobAbilities.byEntity.has(casterEid)) {
    clearMobAbility(world, casterEid);
  }
  const token = world.mobAbilities.nextToken;
  world.mobAbilities.nextToken += 1;
  world.mobAbilities.registrationTokens.set(casterEid, token);
  world.mobAbilities.byEntity.set(casterEid, {
    definition,
    phase: 'cooldown',
    timerMs: definition.firstEligibleAfterMs,
    committedGeometry: null,
    committedTargetEid: null,
    resolvedCasts: 0,
    announcementsEmitted: 0,
    registrationToken: token,
  });
}

/**
 * Release every piece of state owned by a caster's ability: its instance, its
 * committed cue, and any status effects it applied to any entity. Used by the
 * cleanup paths (death/despawn/disable/recycled-id/invalid-target).
 */
export function clearMobAbility(world: GameWorld, casterEid: number): void {
  const runtime = world.mobAbilities;
  const inst = runtime.byEntity.get(casterEid);
  if (inst === undefined) return;
  runtime.byEntity.delete(casterEid);
  runtime.registrationTokens.delete(casterEid);

  // Drop any committed cue for this caster.
  for (let i = runtime.cues.length - 1; i >= 0; i -= 1) {
    if (runtime.cues[i]!.casterEid === casterEid) runtime.cues.splice(i, 1);
  }

  // Retire cast announcements owned by this caster so canceled telegraphs do not
  // stay visible on the HUD banner.
  const announcementPrefix = `${mobAbilitySourceId(inst.definition.abilityId, casterEid)}:cast-`;
  for (let i = world.announcements.length - 1; i >= 0; i -= 1) {
    const event = world.announcements[i]!;
    if (event.kind !== 'bossAbilityCast') continue;
    if (event.eventId?.startsWith(announcementPrefix)) {
      world.announcements.splice(i, 1);
    }
  }

  // Release owned status effects (e.g. Tarnished) from every affected entity.
  const sourceId = mobAbilitySourceId(inst.definition.abilityId, casterEid);
  for (const eid of [...world.statusEffectsByEntity.keys()]) {
    clearStatusEffects(world, eid, (effect) => effect.sourceId === sourceId);
  }
}

/** Enable/disable the runtime feature gate. Disabling clears all cues + clocks. */
export function setMobAbilitiesEnabled(world: GameWorld, enabled: boolean): void {
  world.mobAbilities.enabled = enabled;
  if (!enabled) disableMobAbilityEncounter(world);
}

/**
 * Mark the encounter explicitly active and (re)anchor every registered ability's
 * first-eligibility clock. This is the ONLY place ability clocks begin — call it
 * at the arena `encounter.started` transition, never at spawn.
 */
export function activateMobAbilityEncounter(world: GameWorld): void {
  const runtime = world.mobAbilities;
  runtime.encounterActive = true;
  for (const inst of runtime.byEntity.values()) {
    inst.phase = 'cooldown';
    inst.timerMs = inst.definition.firstEligibleAfterMs;
    inst.committedGeometry = null;
    inst.committedTargetEid = null;
  }
}

/** Deactivate the encounter and release all in-flight cues + owned effects. */
export function disableMobAbilityEncounter(world: GameWorld): void {
  const runtime = world.mobAbilities;
  runtime.encounterActive = false;
  for (const casterEid of [...runtime.byEntity.keys()]) {
    clearMobAbility(world, casterEid);
  }
  runtime.cues.length = 0;
}

/** A caster is valid iff it still exists, is alive, and is still its own boss. */
function isCasterValid(world: GameWorld, eid: number, inst: MobAbilityInstanceState): boolean {
  if (!entityExists(world.ecs, eid)) return false;
  if (!hasComponent(world.ecs, eid, Health)) return false;
  if ((world.stores.health.current[eid] ?? 0) <= 0) return false;
  // Appearance-key guard: the slot must still carry the same boss archetype.
  if (world.enemyAppearanceKeys.get(eid) !== inst.definition.bossArchetypeKey) return false;
  // Generation-token guard: detect same-archetype EID recycling within a tick.
  // If a new entity of the same archetype reuses this EID before mobAbilitySystem
  // runs (e.g. Queen dies and a fresh faerie-boss spawns in the same tick), the
  // token in registrationTokens will have changed (new registration) or been
  // deleted (no re-registration) — either way it no longer matches inst.
  return world.mobAbilities.registrationTokens.get(eid) === inst.registrationToken;
}

/** Resolve the current target's live position, or `null` if it is gone. */
function targetPosition(
  world: GameWorld,
  targetEid: number | null,
): { x: number; y: number } | null {
  if (targetEid === null || !entityExists(world.ecs, targetEid)) return null;
  const x = world.stores.position.x[targetEid];
  const y = world.stores.position.y[targetEid];
  if (x === undefined || y === undefined) return null;
  return { x, y };
}

/**
 * A target is valid iff it still exists, is still the player, and has non-zero
 * health. This preserves target identity across the telegraph window: if the
 * locked player EID is recycled into any other health-bearing entity,
 * {@link resolveCast} takes the invalid-target cleanup path instead of resolving
 * against the wrong target.
 */
function isTargetValid(world: GameWorld, targetEid: number | null): boolean {
  if (targetEid === null || !entityExists(world.ecs, targetEid)) return false;
  if (!hasComponent(world.ecs, targetEid, Health)) return false;
  if (!hasComponent(world.ecs, targetEid, Player)) return false;
  if ((world.stores.health.current[targetEid] ?? 0) <= 0) return false;
  return true;
}

function beginTelegraph(world: GameWorld, casterEid: number, inst: MobAbilityInstanceState): void {
  const def = inst.definition;
  // Commit target + origin + geometry ONCE, now. Nothing tracks after this.
  const targetEid = findDefaultTarget(world);
  const pos = targetPosition(world, targetEid);
  if (pos === null) {
    // No valid target to lock onto — skip this cast and re-arm the cooldown so
    // the boss tries again next cycle instead of firing a phantom telegraph.
    inst.phase = 'cooldown';
    inst.timerMs = def.cooldownMs;
    return;
  }
  inst.phase = 'telegraph';
  inst.timerMs = def.telegraphDurationMs;
  inst.committedTargetEid = targetEid;
  inst.committedGeometry = {
    kind: 'circle',
    x: pos.x,
    y: pos.y,
    radiusFt: def.geometry.radiusFt,
  };

  // Announcement is emitted exactly once, here, per cast.
  pushAnnouncement(world.announcements, {
    kind: 'bossAbilityCast',
    archetypeIndex: -1,
    text: def.announcementText,
    eventId: `${mobAbilitySourceId(def.abilityId, casterEid)}:cast-${inst.announcementsEmitted + 1}`,
    durationMs: ANNOUNCEMENT_DURATION_MS,
    elapsedMs: world.elapsedMs,
  });
  inst.announcementsEmitted += 1;
}

function resolveCast(world: GameWorld, casterEid: number, inst: MobAbilityInstanceState): void {
  const def = inst.definition;
  const geometry = inst.committedGeometry;
  // Revalidate the locked target before resolution. If the player died,
  // despawned, or its ID was recycled during the 1.5s telegraph, skip the
  // resolve call and take the cancellation/cleanup path instead.
  if (geometry !== null && isTargetValid(world, inst.committedTargetEid)) {
    def.resolve(world, {
      abilityId: def.abilityId,
      casterEid,
      sourceId: mobAbilitySourceId(def.abilityId, casterEid),
      geometry,
      targetEid: inst.committedTargetEid,
    });
    inst.resolvedCasts += 1;
  }
  // Re-arm: cooldown is anchored AFTER resolution.
  inst.phase = 'cooldown';
  inst.timerMs = def.cooldownMs;
  inst.committedGeometry = null;
  inst.committedTargetEid = null;
}

/** Default target selection: the living player singleton (catalog `player-position`). */
function findDefaultTarget(world: GameWorld): number | null {
  const players = query(world.ecs, [Player, Position]);
  for (const eid of players) {
    // A dead/invalid target must never anchor a telegraph — treat it as absent
    // so beginTelegraph takes the skip-and-re-arm path.
    if (!hasComponent(world.ecs, eid, Health)) continue;
    if ((world.stores.health.current[eid] ?? 0) <= 0) continue;
    return eid;
  }
  return null;
}

/**
 * Advance every registered ability one fixed step. No-op unless the runtime is
 * enabled and the encounter is active; always leaves `cues` empty when idle so
 * the renderer never shows a stale telegraph.
 */
export function mobAbilitySystem(world: GameWorld): void {
  const runtime = world.mobAbilities;
  runtime.cues.length = 0;
  if (!runtime.enabled || !runtime.encounterActive) return;
  if (runtime.byEntity.size === 0) return;

  const dtMs = GAME.DELTA_MS;

  for (const casterEid of [...runtime.byEntity.keys()]) {
    const inst = runtime.byEntity.get(casterEid);
    if (inst === undefined) continue;

    // Cleanup: dead/despawned/recycled casters release all owned state.
    if (!isCasterValid(world, casterEid, inst)) {
      clearMobAbility(world, casterEid);
      continue;
    }

    inst.timerMs -= dtMs;
    if (inst.timerMs <= TIMER_EPSILON_MS) {
      if (inst.phase === 'cooldown') {
        beginTelegraph(world, casterEid, inst);
      } else {
        resolveCast(world, casterEid, inst);
      }
    }

    // Publish committed cue state for the renderer (telegraph phase only).
    if (inst.phase === 'telegraph' && inst.committedGeometry !== null) {
      const progress = 1 - Math.max(0, inst.timerMs) / inst.definition.telegraphDurationMs;
      runtime.cues.push({
        abilityId: inst.definition.abilityId,
        casterEid,
        phase: 'telegraph',
        telegraphProgress: Math.min(1, Math.max(0, progress)),
        geometry: inst.committedGeometry,
        dangerColor: inst.definition.dangerColor,
        announcementText: inst.definition.announcementText,
      });
    }
  }
}
