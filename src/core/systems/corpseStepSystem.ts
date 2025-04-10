/**
 * Corpse Step System — the player brushing a corpse mid-linger has a small
 * chance to burst it into shards.
 *
 * A corpse is any enemy still carrying a `DeathTimer` (its post-death linger
 * window before `deathTimerSystem` reaps it). When the player transitions
 * INTO a corpse's step radius — i.e. the player was NOT overlapping it last
 * frame but IS this frame — we roll {@link CORPSE_STEP_TRIGGER_CHANCE}. On a
 * hit we call `applyDamage` on the corpse, which the shared corpse-hit path
 * (in `apply-damage.ts`) turns into a `corpseExplode` combat event AND zeroes
 * the corpse's `DeathTimer.remainingMs` so it's reaped this same frame.
 *
 * Bursting a corpse is a REAL gameplay state change, not just a visual
 * flourish: it removes the body from the world early, so any future system
 * that consumes corpses (e.g. necromancy raising the dead) sees one fewer
 * corpse available. This is why the burst must respect entities whose death
 * carries additional scripted logic — see the `Spawner` exclusion below.
 *
 * Spawner exclusion: a {@link Spawner} structure (rats-nest, slime pit, …) is
 * tagged `Enemy` and lingers via `DeathTimer` after it dies, so it would
 * otherwise match the corpse query. We MUST NOT burst it. A spawner's death is
 * a multi-tick scripted handshake: `spawnerSystem` fires its one-shot finale
 * wave and sets `deathResolved` on the tick AFTER the kill, and
 * `spawnerArenaSystem` then reads `deathResolved` to run its LOCKED→RESOLVED
 * transition (lower the fence / unlock doors, grant banked XP). Reaping the
 * spawner corpse early — the player is standing on it the instant it dies from
 * a melee kill — destroys the entity before that handshake completes, so the
 * arena is orphaned in a permanently-locked, target-less state and the player
 * is trapped forever. Thematically a nest/structure also shouldn't gib into
 * gore shards from a footstep. Both reasons say: skip `Spawner` corpses.
 *
 * Determinism: the 10% roll is a hash of `(seed, frameCount, corpseEid)` via
 * {@link hashStringToSeed}, NOT `world.rng.next()`, so this system doesn't
 * perturb the seeded RNG stream that gameplay rolls (crit, dodge, enemy AI)
 * consume. That keeps existing win-rate seeds byte-identical.
 *
 * Runs after `movementSystem` (so player position is fresh) and before
 * `deathTimerSystem` (so a triggered corpse's zeroed timer is reaped this
 * frame).
 */
import { hasComponent, query } from 'bitecs';
import { DeathTimer, Enemy, Player, Position, Spawner } from '../components.js';
import { applyDamage } from '../apply-damage.js';
import { hashStringToSeed } from '../../shared/random.js';
import type { GameWorld } from '../world.js';

/**
 * Distance (feet) within which the player is considered to be stepping on a
 * corpse. Kept tight so the player must be roughly on top of the body — a
 * grazing pass shouldn't detonate it.
 */
export const CORPSE_STEP_RANGE_FT = 0.9;

/** Probability that a fresh step onto a corpse bursts it. */
export const CORPSE_STEP_TRIGGER_CHANCE = 0.1;

/**
 * Corpses the player was overlapping on the PREVIOUS frame, per world. Used
 * to detect the enter-transition so a player standing still on a corpse
 * doesn't get re-rolled every frame. WeakMap so a discarded world is GC'd.
 */
const prevOverlapByWorld = new WeakMap<GameWorld, Set<number>>();

/** Deterministic 10% roll from `(seed, frame, eid)` — no shared-RNG side-effects. */
function shouldTriggerStep(world: GameWorld, corpseEid: number): boolean {
  const h = hashStringToSeed(`${world.seed}:${world.frameCount}:${corpseEid}`);
  // `hashStringToSeed` returns a 32-bit int. Reduce to [0, 1) and gate at 10%.
  const roll = ((h >>> 0) % 1_000_000) / 1_000_000;
  return roll < CORPSE_STEP_TRIGGER_CHANCE;
}

export function corpseStepSystem(world: GameWorld): void {
  const players = query(world.ecs, [Player, Position]);
  if (players.length === 0) {
    // No player this frame — clear tracked state so eid reuse doesn't leak.
    prevOverlapByWorld.get(world)?.clear();
    return;
  }
  const playerEid = players[0]!;
  const { position } = world.stores;
  const px = position.x[playerEid] ?? 0;
  const py = position.y[playerEid] ?? 0;

  const corpses = query(world.ecs, [Enemy, DeathTimer, Position]);
  const rangeSq = CORPSE_STEP_RANGE_FT * CORPSE_STEP_RANGE_FT;

  let prev = prevOverlapByWorld.get(world);
  if (!prev) {
    prev = new Set<number>();
    prevOverlapByWorld.set(world, prev);
  }
  const nextOverlap = new Set<number>();

  for (const eid of corpses) {
    if (eid === undefined) continue;
    // Structures (Spawner: rats-nest / slime pit) are tagged Enemy and linger
    // via DeathTimer, so they match the corpse query — but bursting one early
    // destroys the entity before its scripted death handshake completes
    // (spawnerSystem's finale wave + deathResolved, then spawnerArenaSystem's
    // LOCKED→RESOLVED transition), permanently orphaning the arena and trapping
    // the player. Never step-burst a spawner corpse. See the file header.
    if (hasComponent(world.ecs, eid, Spawner)) continue;
    // A corpse that already had its timer zeroed this frame (e.g. by a
    // player weapon hit) is on its way out; don't re-roll it.
    if ((world.stores.deathTimer.remainingMs[eid] ?? 0) <= 0) continue;

    const cx = position.x[eid] ?? 0;
    const cy = position.y[eid] ?? 0;
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy > rangeSq) continue;

    nextOverlap.add(eid);

    // Only NEW overlaps (a fresh step onto) can trigger. Standing still on a
    // corpse doesn't re-roll every frame.
    if (prev.has(eid)) continue;

    if (shouldTriggerStep(world, eid)) {
      // Route through the shared corpse-hit path so the corpseExplode event,
      // blood colour, sprite variant, and knockback direction match a weapon
      // hit. The blow "comes from" the player's centre — shards spray forward
      // along the player's approach. This always resolves via the corpse
      // early-return branch in applyDamage (before any scaling/crit check), so
      // the exact affinity/scaleWithPrimary/canCrit values here are inert —
      // origin: 'player' + unscaled/no-crit is the fail-closed, contextually
      // accurate choice.
      applyDamage(world, eid, 1, cx, cy, {
        origin: 'player',
        affinity: 'unscaled',
        scaleWithPrimary: false,
        canCrit: false,
        sourceX: px,
        sourceY: py,
        sourceEid: playerEid,
      });
    }
  }

  prevOverlapByWorld.set(world, nextOverlap);
}

/**
 * Test hook: wipe the tracked per-world overlap set so a subsequent step in
 * the same test world is treated as an enter-transition. Not called from
 * runtime code.
 */
export function _resetCorpseStepTrackingForTest(world: GameWorld): void {
  prevOverlapByWorld.delete(world);
}
