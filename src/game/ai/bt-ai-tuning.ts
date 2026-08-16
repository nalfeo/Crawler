/**
 * Behavior-tree AI tuning constants.
 *
 * Pure tuning values extracted verbatim from `bt-ai-provider.ts` so the knobs
 * that shape the AI's movement, kiting, navigation, retreat, exploration and
 * watchdog behavior are discoverable in one place. These are values only — no
 * behavior lives here. `bt-ai-provider.ts` imports the names it uses, so the
 * runtime behavior is byte-for-byte identical to having them declared inline.
 *
 * @see bt-ai-provider.ts
 */
import { AIDecisionMode, AIPathingMode, type AIConfig } from './types.js';

// Production default AI config. Promoted from the AI Sweep winner (2026-07-21):
// GitHub Actions recovery run 29893475612, leaderboard artifact provenance
// workflowSha=18929bed51edb1979db2650e3329cf4fe63ff418. Composite and
// lexicographic winners agreed on pathingMode=riskRewardFused,
// decisionMode=legacy, retreatThreshold=0.1, farmPullWeight=0.12 (all other
// knobs already matched the prior incumbent default). Validation: 294/300 wins
// (98%; 98/100 each sword/bow/baseball-bat) vs the legacy+legacy incumbent's
// 286/300 (retreatThreshold=0.15) — +8 wins, +2.6667pp, with 3 incumbent
// win→loss flips allowed by the merged net-win promotion rule. See
// docs/knowledge/handoffs/2026-07-22-promote-recovered-ai-sweep-winner.md. Do NOT
// weaken these exact values to satisfy a test — fix the test instead.
export const DEFAULT_CONFIG: Required<AIConfig> = {
  seed: 12345,
  aggression: 1,
  retreatThreshold: 0.1,
  retreatDangerRadius: 20,
  scanRadius: 50,
  rangedSafeDistance: 15,
  opportunisticGrabRadius: 18,
  dodgeWeight: 0.25,
  // Loot-detour pull weight. The opportunistic collect layer only pulls toward
  // loot within 5 ft of the player's forward path (an "on-path detour"), so
  // unlike the old omnidirectional pull it cannot systematically drift the net
  // trajectory toward off-path loot-dense (= enemy-dense) zones — the failure
  // mode that previously forced this to 0.0 and blew the headless floor-clear
  // budget. A modest weight keeps Track A's path dominant so the player just
  // curves toward pickups it passes near.
  collectPullWeight: 0.5,
  // Enemy-farm pull: drift toward the nearest enemy AHEAD on the player's path
  // while travelling (explore + quest-objective navigation), so auto-fire starts
  // sooner on swarm the player walks past. Kept forward-biased (see
  // OpportunisticFarm) so Track A's quest path stays dominant and the pull can
  // never drag the player off-objective into an off-path fight — the failure
  // mode that previously forced this to 0.0 and blew the floor-clear budget.
  // Raised 0.07→0.12 by the AI Sweep winner promotion above.
  farmPullWeight: 0.12,
  // A/B axis 1: RISK_REWARD_FUSED is the 2026-07-21 AI Sweep winner (294/300).
  // A/B axis 2: LEGACY — fixed-priority Track A ladder.
  pathingMode: AIPathingMode.RISK_REWARD_FUSED,
  decisionMode: AIDecisionMode.LEGACY,
  debug: false,
};

export const DIRECT_MOVE_EPSILON_FT = 1.25;
// --- Ranged kiting (standoff orbit) ---
// For ranged weapons the AI wants to stay at ~75 % of weapon range: close enough
// to land shots but far enough that enemies cannot freely swing at it. It orbits
// laterally (reusing the same sign/flip infrastructure as melee kite) so it is
// never a stationary target.
// Desired orbit as a fraction of the weapon's feet reach. Kept moderate (not the
// full weapon range): at long standoff the projectile's travel time lets wandering
// ambient enemies sidestep shots, so the AI orbited for minutes without finishing
// the last quest kills. Fighting nearer trades a little incoming-hit exposure for
// reliable hits (and line-of-sight) on weak swarm enemies — a net win for clear speed.
export const RANGED_STANDOFF_FRACTION = 0.5;
// Absolute cap (ft) on the ranged standoff orbit, independent of the weapon's
// (often huge) max range. The bow's reach is 44ft, but at that distance a 0.75ft/
// frame projectile takes ~0.5s to arrive and a wandering rat (0.15625ft/frame)
// sidesteps it — so long-standoff bows whiff most shots and never finish the
// swarm. The player moves 0.375ft/frame (2.4x a rat), so it can hold a much tighter
// ring and still never be caught: fighting at ~12ft makes projectile travel time
// short enough that shots reliably connect, roughly tripling effective bow DPS.
// Floored at CONTACT_SAFE_ORBIT_FT so it never parks inside body-contact range.
export const RANGED_STANDOFF_ABS_FT = 6;
// Once health falls below this fraction, a projectile user with an enemy already
// inside its configured ranged-safe distance expands the orbit instead of
// continuing to close toward the healthy 6ft damage-optimized ring. The healthy
// baseline stays unchanged; this only arrests the deterministic contact-damage
// spiral after the player is wounded.
export const RANGED_DEFENSIVE_HP_FRACTION = 0.7;
// A wounded projectile user expands only to a short, combat-effective ring.
// Longer standoffs avoid contact but make un-led projectiles miss moving targets,
// converting deaths into tutorial stalls. Ten feet keeps pistol/knife shots
// reliable while creating substantially more reaction room than the healthy 6ft
// ring.
export const RANGED_DEFENSIVE_REACH_FRACTION = 0.5;
export const RANGED_DEFENSIVE_ABS_FT = 10;
// Once defensive spacing starts, keep it until the nearby-pressure bubble is
// fully clear. Without this wider release radius the AI alternates every few
// frames between closing to 6ft and retreating, losing both safety and DPS.
export const RANGED_DEFENSIVE_RELEASE_MULTIPLIER = 2;
// Ranged micro-spacing: fraction of the standoff radius the AI eases farther out
// while a shot is on cooldown (then settles back to the standoff as the shot
// readies), so all weapons stutter-step rather than holding a static distance.
export const RANGED_RECOVER_EXTRA_FRACTION = 0.2;
// Tolerance band around the desired orbit (ft). Inside this band the AI switches
// from a direct A*-navigated approach/retreat to fine-grained orbit steps so it
// does not constantly re-plan the path to a moving target.
export const RANGED_APPROACH_BUFFER_FT = 3;

// --- Melee kiting (stutter-step orbit) ---
// When in melee, the player must NOT park on the enemy and trade blows. Instead
// it advances/retreats along the enemy axis (keeping the weapon on target) while
// slightly strafing as a juke. MELEE_HOLD_FRACTION places the preferred orbit
// well inside weapon reach so every swing lands reliably.
// 0.5 puts the player at half weapon reach — deep inside the strike band so hits
// land solidly and the player commits to the fight instead of hovering on the edge.
export const MELEE_HOLD_FRACTION = 0.5;
// Micro-spacing recover radius (fraction of weapon reach) the player eases out to
// right after a swing, then pulls back to MELEE_HOLD_FRACTION as the next swing
// readies. Kept a modest poke beyond the strike hold (≈human's ~25% amplitude
// dip near contact, NOT a full back-off): far enough to dodge between hits, close
// enough that the enemy stays deep inside the strike gate so DPS — and AoE cleave
// on swarms — is preserved. Larger values (e.g. 0.95) measurably slowed clears
// and regressed previously-winning seeds.
export const MELEE_RECOVER_HOLD_FRACTION = 0.7;
// Below this health fraction the melee kite switches to DEFENSIVE spacing: it
// expands the orbit toward the real blade reach so it sits beyond shorter enemy
// attack ranges when possible without retreating outside guaranteed hit geometry.
// With no passive regen, a wounded AI must still kill to level up and heal, so the
// goal is "keep landing auto-fire hits without getting hit" rather than fleeing.
export const MELEE_DEFENSIVE_HP_FRACTION = 0.4;
// Matches weaponSystem's permissive ATTACK_TARGET_GATE_MULTIPLIER. It starts a
// melee swing early while the target is closing, but does not define the blade's
// guaranteed hit radius and therefore must not be used as a stationary orbit.
export const ATTACK_GATE_MULTIPLIER = 1.5;
// Minimum center-to-center distance (ft) the melee kite holds so the player body
// never overlaps a swarm enemy's body. Swarm enemies (rats/slimes) carry NO ranged
// attackRange — they deal CONTACT damage on AABB body overlap (damageSystem). The
// player half-extent is 1.5ft and the largest swarm (slime) is 1.5ft, so head-on
// contact fires at ≤3ft center distance; this sits a ~1.5ft buffer outside that.
// Crucially it is still inside every melee swing radius (sword 5 / bat 5.5 /
// hammer 6 ft) so auto-fire swings keep landing while the body stays untouched —
// the single biggest fix for the melee "retreat death-spiral" (orbiting at the old
// 2.75-3.875ft band meant standing INSIDE contact range, bleeding ~20 dmg/s for free).
export const CONTACT_SAFE_ORBIT_FT = 4.5;
// Micro-spacing dodge amplitude (ft) added beyond the contact-safe strike hold when
// a swing is on cooldown. Modest by design: a gentle in/out poke that breaks body
// contact between swings without backing so far the clear slows (prior large-
// amplitude experiments measurably regressed winning seeds).
export const MELEE_DODGE_AMPLITUDE_FT = 1.75;
// Extra ft held beyond a (smaller-than-reach) enemy's own attackRange when we can
// safely poke from outside its strike range. Ignored for long-range bosses whose
// attackRange dwarfs our reach (geometrically impossible to outrange).
export const KITE_DODGE_BUFFER_FT = 1.75;
// Per-step orbit travel target distance. Small (< CLOSE_APPROACH_DIRECT_FT) so the
// move primitive's close-approach branch drives it with obstacle-sliding local
// navigation instead of tile A*, yielding smooth strafing rather than wiggle.
export const KITE_STEP_FT = 3.5;
// Max radial correction blended per step toward the desired orbit radius. Set equal
// to KITE_STEP_FT so forward/backward corrections fully dominate when off-radius.
export const KITE_RADIAL_STEP_FT = KITE_STEP_FT;
// Lateral strafe component when no back-threat is detected. Keep small so the
// primary motion is radial (advance/retreat) with just a juke twitch; full orbit
// is reserved for enemies approaching from behind. ~25 % of KITE_STEP_FT.
export const KITE_STRAFE_FT = KITE_STEP_FT * 0.25;
// Radius (ft) within which a non-primary enemy counts as a back threat.
export const KITE_BACK_THREAT_RADIUS_FT = 20;
// Radius (ft) used by ranged kiting's multi-threat scans: bounds how far
// `computeOtherThreatEscapePush` and `findNearestOtherEnemyDistance` look
// for other enemies. Note: the scan radius alone does NOT trigger an earlier
// reaction — `computeOtherThreatEscapePush` only engages once a threat has
// already breached the tighter `spacedOrbit` standoff ring (~4.5-7.2ft), so
// the scan radius is non-binding for the escape-push. Its primary practical
// effect is as the base for deriving SAFE_LOOT_ENEMY_CLEARANCE_FT below.
// Matched to KITE_BACK_THREAT_RADIUS_FT for consistency across threat scans.
export const RANGED_MULTI_THREAT_SCAN_FT = KITE_BACK_THREAT_RADIUS_FT;
// Minimum distance (ft) to the nearest perceived enemy before a ranged-kiting
// "safe loot detour" is considered. Deliberately wider than
// RANGED_MULTI_THREAT_SCAN_FT so the AI only breaks off orbiting to grab loot
// once every nearby enemy has actually cleared the multi-threat defense
// radius — never while a threat could still be closing in.
export const SAFE_LOOT_ENEMY_CLEARANCE_FT = RANGED_MULTI_THREAT_SCAN_FT * 1.5;
// Max distance (ft) a ranged-kiting AI will detour off its orbit position to
// grab loot. Kept short and well inside scanRadius (50ft) so the detour never
// wanders toward new danger or turns into a long cross-room errand — this is
// an opportunistic "grab it since I'm already clear" pickup, not a dedicated
// loot run (that remains Collect's job once no threat is nearby at all).
export const LOOT_DETOUR_MAX_FT = 15;
// Frames between deterministic orbit-direction flips (~2.2s at 60fps). Periodic
// reversal keeps the player juking and prevents it from grinding into one wall
// forever; far longer than any oscillation so it reads as intentional kiting.
export const KITE_FLIP_FRAMES = 132;
export const NAVIGATION_LOOKAHEAD_FT = 3;
// Per-frame blend fraction for output-direction smoothing. Exponential decay
// toward the desired move vector so waypoint transitions and kite reversals
// produce a smooth arc rather than an instant 90° snap. Value is tuned so a
// full cardinal-direction change completes in ~4-5 frames (~70ms at 60fps) while
// keeping top speed virtually unaffected during straight-line travel.
export const MOVE_SMOOTH_FACTOR = 0.5;
// Close-range direct approach threshold (~1.5 tiles). Within this distance, and
// with a clear straight corridor, the AI abandons tile-granular A* and slides
// straight at the exact target position. Tile A* targets tile CENTERS and cannot
// step the 3ft player body onto a 1ft pickup; resolveReachableGoalTile also
// diverts to an adjacent tile whenever the target sits in the player's own tile
// (same-tile A* is trivial), producing the walk-away/walk-back "wiggling on
// pickups" oscillation. Direct approach drives the body to physically overlap
// the pickup (AABB overlap fires within 2ft/axis) so collision collects it.
export const CLOSE_APPROACH_DIRECT_FT = 6;
// Step (ft) used to sample the corridor for hasClearLineOfSight. Half a tile so
// a wall tile between the player and target cannot be skipped over.
export const LINE_OF_SIGHT_SAMPLE_FT = 1;
// Distance (ft) at which the player is considered to have reached a path
// waypoint and advances to the next. A quarter-tile (1ft) keeps the body on the
// A* line through corners; a looser radius makes the AI cut corners early and
// wedge against the wall it was routing around (observed as a multi-second
// EXPLORE oscillation that collapses travel efficiency).
export const WAYPOINT_ARRIVE_FT = 1;
// Wedge recovery for path-following: if the player is aiming at a waypoint but
// collision keeps it from advancing more than MOVE_WEDGE_PROGRESS_FT per frame
// for MOVE_WEDGE_FRAMES straight frames, it is wedged on a choke/corner (e.g. a
// doorway into the boss room). Skip the stuck waypoint and hand off to
// obstacle-sliding local navigation so it threads the gap instead of vibrating
// 1.625ft short of the goal forever (observed seed 3 freezing 160s at a boss door).
export const MOVE_WEDGE_PROGRESS_FT = 0.1875;
export const MOVE_WEDGE_FRAMES = 24;
export const PATH_GOAL_SEARCH_RADIUS_TILES = 6;
export const STUCK_PROGRESS_EPSILON_FT = 0.5;
export const NAVIGATION_MAX_PATH_LENGTH = 1_024;
// Upper bound on distinct (start, goal, radius) entries kept in the
// resolve-reachable-goal memo before it is flushed. The memo is also cleared
// whenever the navigation epoch changes (door/floor change), so this only
// guards against unbounded growth from a long single-epoch wander.
export const RESOLVE_GOAL_MEMO_MAX = 512;
// How long (frames) to ignore an enemy after abandoning it as unreachable.
export const ENEMY_IGNORE_FRAMES = 240;
// Minimum ft the gap to a target enemy must close to count as engagement progress.
export const ENGAGE_PROGRESS_EPSILON_FT = 0.75;
// Frames of no distance/HP progress against the same enemy before we abandon it.
export const ENGAGE_GIVEUP_FRAMES = 120;
// Minimum ft from the enemy the player stops actively pursuing. Mirrors
// MIN_MOB_PLAYER_DISTANCE in enemyAISystem so the player closes to the same
// near-contact range as melee mobs before the kite/orbit loop takes over.
export const MIN_PLAYER_ENEMY_CONTACT_FT = 1.5;
// Smoothed-velocity magnitude below which the player is considered stalled
// during ENGAGE. When stalled but enemy is still far, direct pursuit replaces
// the stall — mirrors enemyAISystem's pathDirection.length ≤ EPSILON check.
export const ENGAGE_STALL_VELOCITY_THRESHOLD = 0.15;
// Frames of no distance progress toward a COLLECT loot target before we abandon
// it. Retained for the engage watchdog's epsilon reuse; the COLLECT deadlock is
// handled by the dwell watchdog below.
// How many frames an unreachable loot pile stays blacklisted once abandoned.
export const LOOT_IGNORE_FRAMES = 300;
// COLLECT dwell watchdog: the per-target distance watchdog is defeated when the
// AI rotates between several mutually-unreachable gems clustered together — each
// target switch resets the per-target counter before it can fire. Instead we
// track the player's NET displacement while continuously in COLLECT. If the
// player stays parked inside a small circle for too long (wiggling against a wall
// chasing an unreachable cluster), we blacklist every loot pile in that circle at
// once so the tree falls through to Hunt/Explore.
// Net ft the player must travel from the dwell anchor to count as real progress.
export const COLLECT_DWELL_ESCAPE_FT = 8;
// Frames parked inside the dwell circle (no net escape) before we give up.
export const COLLECT_DWELL_FRAMES = 180;
// Radius (ft) around the parked player whose loot is blacklisted as unreachable.
export const COLLECT_DWELL_CLUSTER_RADIUS_FT = 12;
// EXPLORE dwell watchdog: pickExploreTarget chooses a random passable tile and the
// Explore node only re-picks once the player gets within 6.25ft of it. If that tile
// is unreachable (behind a locked door, across an unpathable gap), the player
// wiggles against the obstacle forever without ever re-picking — the per-frame
// stuck counter is defeated by the same wiggle that keeps net displacement above
// its epsilon. So we track NET displacement while continuously in EXPLORE and, if
// the player never escapes a small circle, force a fresh explore target.
// Net ft the player must travel from the dwell anchor to count as real progress.
export const EXPLORE_DWELL_ESCAPE_FT = 8;
// Frames parked inside the dwell circle before we force a new explore target.
export const EXPLORE_DWELL_FRAMES = 180;
// After a dwell-watchdog fires on a position-based progress target (Tutorial Goon,
// Shopkeeper, boss room, etc.) the BT immediately re-assigns the same unreachable
// position on the next frame, creating a permanent freeze. Suppress ALL position-
// progress goals for this many frames so the tree falls through to Hunt/Engage
// and the AI keeps fighting while the path is blocked. The goal re-evaluates once
// the window expires, so it catches up when a door opens or the player moves closer.
export const PROGRESS_SUPPRESS_FRAMES = 360;
// Floor 2 family hunts stay inside the authored territory spawn zone and rotate
// among deterministic interior patrol anchors when the selected family is absent.
export const FLOOR2_HUNT_PATROL_ARRIVE_FT = 8;
export const FLOOR2_HUNT_PATROL_RADIUS_FRACTION = 0.92;
export const FLOOR2_HUNT_CHASE_RADIUS_FT = 120;
export const FLOOR2_HUNT_NO_PROGRESS_FRAMES = 600;
// Keep family hunts combat-forward without pinning the AI in ENGAGE for the
// entire objective: 45 seconds of focused fighting, then 15 seconds of patrol.
export const FLOOR2_HUNT_ENGAGE_FRAMES = 2700;
export const FLOOR2_HUNT_RECOVERY_FRAMES = 900;
// Inside the final six minutes of Floor 2's production collapse timer, stay on
// the selected family instead of taking another patrol recovery.
export const FLOOR2_HUNT_URGENCY_REMAINING_MS = 360_000;
// EXPLORE reachability sampling: the dwell watchdog stops the AI wiggling against
// a single unreachable frontier forever, but if pickExploreTarget keeps re-rolling
// random passable tiles that happen to be unreachable from the player's current
// pocket, the AI parks in place re-rolling endlessly (only the symptom changes
// from one long wiggle to many short ones). The cure is to A*-verify candidates
// and only ever hand the Explore node a reachable target, biased toward distant
// ones to maximise new ground revealed.
// Random passable tiles to sample per explore re-pick before giving up on A*.
export const EXPLORE_REACHABLE_SAMPLE_ATTEMPTS = 40;
// Reachable candidates to gather before stopping the sample sweep early.
export const EXPLORE_REACHABLE_SAMPLE_TARGET = 6;
// Among the farthest reachable candidates, randomly pick from this many so the AI
// does not oscillate deterministically between two fixed extremes.
export const EXPLORE_FAR_CANDIDATE_POOL = 3;
// FRONTIER exploration: the random far-tile sampler above ping-pongs between
// already-seen corners, so an objective in an unentered room is only found by
// luck (observed: Shopkeeper not discovered until ~194s on seed 3, burning the
// 300s floor-collapse budget). Instead the AI keeps a cumulative fog-of-war
// "seen" bitmap (the same data the minimap shows) and steers toward the nearest
// frontier — a seen, reachable tile adjacent to an unseen tile — which sweeps the
// map outward systematically and reveals new rooms (and the NPCs in them) far
// sooner. A door into an unexplored room is itself a frontier, so this also
// satisfies the "prioritise uncovering doors" intent. The random sampler is kept
// as a fallback for when nothing unseen remains reachable.
//
// Cap on tiles expanded by the frontier BFS per re-pick, so a fully-open floor
// cannot make the search unbounded. A re-pick only happens when the player nears
// its current target (~every 1-2s) or a watchdog clears it, so this is cheap.
// Set to exceed the largest map tile count (240×140 = 33_600 tiles) so the
// frontier sweep can always reach the farthest unseen tile on the current floor.
export const EXPLORE_FRONTIER_BFS_MAX_TILES = 40_000;
// Only return frontier targets at least this far from the player. The Explore
// behavior re-picks within 50px, so a closer target would thrash without moving;
// requiring real travel guarantees the fog (and thus the frontier set) changes
// between picks, which structurally prevents a zero-progress lock-on.
export const EXPLORE_FRONTIER_MIN_FT = 10;
// GLOBAL dwell watchdog: the per-state dwell watchdogs (engage/collect/explore)
// each reset the instant their state stops running, so they structurally cannot
// catch CROSS-STATE thrash. When the behavior tree flip-flops between two states
// every single frame — e.g. an enemy that oscillates A*-reachable/unreachable as
// the player wiggles a few ft across a tile edge at a doorway choke, alternating
// ENGAGE (chase the enemy one way) with COLLECT (grab loot the other way) — each
// switch zeroes the other state's counter, none ever accumulate, and the player
// vibrates in place with zero net progress forever (observed: 400s+ frozen). This
// state-agnostic watchdog runs every poll and only forgives genuine progress
// (net travel, closing on the nearest enemy, or damaging the local wave).
// Net ft the player must travel from the dwell anchor to count as real progress.
export const GLOBAL_DWELL_ESCAPE_FT = 12;
// Frames wedged with no progress of any kind before we force a relocation. Set
// longer than the per-state nets (180f) so those fire first whenever they apply;
// this only catches the cross-state thrash they cannot.
export const GLOBAL_DWELL_FRAMES = 300;
// Ft the gap to the nearest reachable enemy must close to count as approach
// progress (mirrors the engage watchdog's epsilon, slightly looser).
export const GLOBAL_DWELL_ENEMY_PROGRESS_FT = 1;
// --- Quest-progress stall watchdog ---------------------------------------
// The global-dwell watchdog re-anchors on spatial drift + nearby-enemy chip
// damage, so a knockback/kite loop (the bat punts a quest enemy just out of
// reach; the wedged player chases in a tight orbit landing chip hits but never
// the kill) keeps it alive indefinitely. This backstop instead keys on a coarse
// floor-progress fingerprint (quest objective ticks + completions + gold) that
// such a deadlock freezes, while legitimately slow combat keeps advancing it.
// Quest score is weighted far above gold so a shop purchase's one-frame gold dip
// still reads as forward progress.
export const QUEST_PROGRESS_SCORE_WEIGHT = 1000;
// Frames of zero floor-progress before forcing a relocation. 12 000 ≈ 200s at
// 60fps: safely longer than the slowest legitimate single-fingerprint span on the
// doubled 240×140 map (cross-map travel ~120s on the bigger floor; the bat boss
// whittle is additionally guarded by the active-boss check) yet far under the
// budget the observed ~188s deadlock wastes on the old map, so it still converts
// genuine deadlocks into wins with margin to spare.
export const QUEST_PROGRESS_STALL_FRAMES = 12_000;

// How far (ft) beyond the nearest enemy the leave-safe-room move target is placed.
// The weapon is disabled inside safe rooms, so the AI must decisively exit rather
// than nudge a few ft against the boundary. Sized larger than a tile (4ft) so the
// clamped A* goal lands outside the safe-room rect even when the enemy hugs it.
export const SAFE_ROOM_EXIT_OVERSHOOT_FT = 12;
// How long (frames) a per-enemy reachability result is reused before recomputing.
// Player movement changes reachability slowly (~0.4ft/frame), so a short TTL keeps
// the A* cost bounded without noticeably lagging behind door/room openings.
export const REACHABILITY_CACHE_TTL_FRAMES = 20;
// Radius (tiles) searched for a pathable approach tile when an enemy's exact
// tile is blocked (e.g. it stands against a wall). Mirrors how movement resolves
// a goal tile so the reachability gate doesn't reject enemies we can actually reach.
export const REACHABILITY_GOAL_SEARCH_RADIUS_TILES = 2;
export const NAVIGATION_ANGLE_OFFSETS = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
] as const;
// Hysteresis for the retreat latch: an enemy must close to within
// retreatDangerRadius to START a retreat, but the AI keeps retreating until the
// gap exceeds retreatDangerRadius * this multiplier. Without this, an enemy
// hovering exactly at the danger boundary makes the AI flip-flop between RETREAT
// and its progression behavior every frame (observed: ~90k flips/run).
export const RETREAT_HYSTERESIS_MULT = 1.5;

// Contact-retreat futility guard. Retreat keeps running against a long-
// `attackRange` threat that has closed to CONTACT_SAFE_ORBIT_FT (see
// buildRetreatBehavior) instead of deferring to Engage's kite. That is only the
// better answer while the retreat can actually create separation: in a corner
// where pickRetreatTarget finds no reachable escape tile it falls back to a raw
// away-vector that points into geometry, navigation resolves no path, and the
// AI stands still bleeding contact damage (the release seed-33 pistol death:
// ~250 frames frozen on one tile, 110 HP -> 12 HP). So the contact carve-out is
// released once it has provably failed to move the player.
// Window (frames) the contact carve-out gets to produce displacement before it
// is judged futile. One second at 60 fps — long enough for the kite to clear a
// doorway, short enough to bound the damage taken while pinned.
export const CONTACT_RETREAT_PROGRESS_FRAMES = 60;
// Displacement (ft) that counts as "the retreat is working" inside that window.
// Anchored to the contact-safe orbit: moving at least one contact radius is the
// smallest move that meaningfully breaks body contact.
export const CONTACT_RETREAT_PROGRESS_FT = CONTACT_SAFE_ORBIT_FT;
// Polls further apart than this (frames) start a fresh futility window rather
// than extending the previous one, so the latch releases naturally once Engage
// has kited back out of contact instead of persisting for the whole floor.
export const CONTACT_RETREAT_EPISODE_GAP_FRAMES = 120;

// Retreat kiting: when fleeing, the AI samples an arc of candidate flee
// directions around the "away from the swarm centroid" base angle, at two
// distances, and picks the most open tile it can actually A*-reach. This
// replaces the old naive single away-from-nearest-threat vector, which pointed
// straight into the wall whenever the player was cornered — navigation then
// found no reachable tile and the player wiggled in place while the swarm killed
// it (the seed-3 boss-fight death). Offsets are in radians; the mirrored set
// spans ±120° in 30° steps (9 directions).
export const RETREAT_ARC_OFFSETS_RAD = [
  0,
  Math.PI / 6,
  -Math.PI / 6,
  Math.PI / 3,
  -Math.PI / 3,
  Math.PI / 2,
  -Math.PI / 2,
  (2 * Math.PI) / 3,
  -(2 * Math.PI) / 3,
] as const;
// Cornered breakout arc: the remaining rearward directions (±150° and 180°),
// scanned ONLY when every candidate in the primary ±120° arc is wall or
// unreachable. That happens when the player is wedged into a room corner with
// the pack occupying the only open quadrant; without these directions Retreat
// falls back to the naive away-vector, which points into the corner the player
// is already pressed against, so collision zeroes its movement and it dies
// standing still (release-sweep seed 25, #2993). Running past the pack is worse
// spacing but strictly better than no movement at all.
// A retreat that covers less than this many feet across a whole re-pick
// interval is not kiting — it is pressed into geometry with its movement
// cancelled by collision (normal travel covers roughly 6-7 ft in that window).
// Only such a wedged retreat widens its escape scan to the breakout arc.
export const RETREAT_WEDGE_PROGRESS_FT = 1;
export const RETREAT_BREAKOUT_ARC_OFFSETS_RAD = [
  (5 * Math.PI) / 6,
  -(5 * Math.PI) / 6,
  Math.PI,
] as const;
// Sample each arc direction at full and half scan radius so a reachable target
// exists even in tight rooms where the far ring is all walls.
export const RETREAT_DISTANCE_MULTS = [1, 0.5] as const;
// Only enemies within this radius shape the flee centroid and the open-space
// score; distant mobs should not bias the escape direction.
export const RETREAT_THREAT_SCAN_FT = 75;
// Cap A* verifications per re-pick so the arc scan stays cheap even with the
// full 18-candidate grid.
export const RETREAT_MAX_PATH_VERIFICATIONS = 6;
// The kite target is recomputed at most this often (frames) — or sooner when the
// AI has no target or has arrived near the current one — keeping the bounded A*
// calls to roughly three re-picks per second instead of one per frame.
export const RETREAT_REPICK_INTERVAL_FRAMES = 18;
export const RETREAT_REPICK_ARRIVE_FT = 10;
// Objective bias for the kite destination. Retreat scores candidates purely on
// open space, so a wounded runner kites BACKWARD off its route; the very next
// poll progression walks the same ground forward into the same pursuers, and the
// pair nets ~zero displacement while contact damage keeps landing (measured on
// the release Floor-1 losses: 684 ft travelled for 133 ft of net movement while
// bleeding 120 HP). Adding a subordinate progress term makes the kite run
// ALONG the route: the player is ~2.4x faster than a rat, so fleeing toward the
// objective both breaks contact and banks progress instead of undoing it.
// The provider normalizes objective progress to directional alignment and caps
// each signed candidate contribution to this fraction of the retreat hysteresis
// band, so two opposing candidates can differ by at most one band.
export const RETREAT_OBJECTIVE_BIAS_BAND_FRACTION = 0.5;
// Weight applied to that capped objective bias band. Keep this at 1 unless a
// sweep shows route-aware retreat should use less than the available safety
// band; the effective per-candidate cap is retreatDangerRadius *
// (RETREAT_HYSTERESIS_MULT - 1) * RETREAT_OBJECTIVE_BIAS_BAND_FRACTION *
// RETREAT_OBJECTIVE_BIAS_WEIGHT.
export const RETREAT_OBJECTIVE_BIAS_WEIGHT = 1;
// The remembered progression objective is only used while it is this fresh
// (frames). Retreat and progression interleave within ~1 s, so a short memory is
// always populated during the oscillation this fixes, and a stale objective from
// a previous route never steers a later escape.
export const RETREAT_OBJECTIVE_MEMORY_FRAMES = 180;
// --- Sustained-damage (time-to-death) retreat trigger -----------------------
// `retreatThreshold` is a fixed fraction of max HP, so it only reacts to how
// much health is LEFT, never to how fast it is leaving. A melee runner pinned in
// contact with a pack drains ~19 HP/s: it burns from full to the 10 % floor in
// about five seconds and only then starts kiting, by which point the run is
// unrecoverable with no healing on Floor 1 (measured on the release Floor-1
// baseball-bat loss: 121 → 21 HP in 5.3 s, all of it above the threshold).
// Sampling the recent health slope lets the AI disengage while the damage is
// still survivable: it retreats when sustained incoming damage would kill it
// inside {@link RETREAT_TIME_TO_DEATH_FRAMES}.
// Window over which the incoming-damage slope is measured (frames). Long enough
// that a single hit does not read as a fatal rate, short enough to react inside
// one contact exchange.
export const RETREAT_DAMAGE_WINDOW_FRAMES = 90;
// Predicted survival horizon (frames). Breaking contact takes about a second of
// kiting (danger radius 20 ft at ~22.5 ft/s), so the horizon must be a small
// multiple of that or the retreat starts too late to matter.
export const RETREAT_TIME_TO_DEATH_FRAMES = 180;
// Ignore the slope until this much damage has landed inside the window, so
// isolated chip hits on a nearly-dead runner cannot masquerade as a burst.
export const RETREAT_DAMAGE_WINDOW_MIN_DAMAGE = 10;

// When the player still owes gold for the merchant charm, the AI actively farms
// the ambient swarm instead of wandering. These scan radii are deliberately
// wider than the default scanRadius so the AI walks toward the swarm/gold across
// a room rather than treating "no enemy within 400px" as "nothing to do" and
// exploring away from the very enemies that drop the gold it needs.
export const GOLD_FARM_ENEMY_SCAN_RADIUS_FT = 150;
export const GOLD_FARM_GOLD_SCAN_RADIUS_FT = 100;
// Only divert to an already-dropped gold pile when it is this close; a pile
// farther than this is more cheaply earned by hunting the swarm (which drops
// fresh coins right next to the kill) than by trekking across the room toward a
// single pile that may have rolled into an unreachable spot. Sized a little
// larger than the melee engage hold (~160px) so coins dropped at a kill site are
// still swept up on the next tick.
export const GOLD_FARM_COLLECT_RADIUS_FT = 32.5;

// --- Opportunistic behavior constants ---
// Enemy must be within this radius (ft) to count as a dodge threat. Sized so the
// player evades swarm contact while travelling toward quest objectives but not so
// wide it routes around enemy pockets it should engage.
export const DODGE_THREAT_RADIUS_FT = 14;
// Minimum closing speed (ft/frame): dot product of enemy velocity with the
// unit toward-player vector. Low enough that ordinary chasers (not just sprint
// chargers) trigger an evasive strafe while the player is navigating.
export const DODGE_CLOSING_SPEED_FT_PER_FRAME = 0.15;
// Path-blocking sidestep: even a stationary/slow enemy parked directly on the
// beeline to an objective must be stepped around, not bulldozed through. An
// enemy within this body-contact radius AND roughly ahead of the travel heading
// (forward dot ≥ DODGE_BLOCK_AHEAD_DOT) triggers a perpendicular sidestep toward
// the open side, regardless of its closing speed. Sized to start curving early
// (at roughly ¾ of the threat scan radius) so the player arcs around stationary
// mobs well before the path converges on them, giving direction-blending time
// to produce smooth curves instead of sharp last-second veer corrections.
export const DODGE_BLOCK_RADIUS_FT = 10;
export const DODGE_BLOCK_AHEAD_DOT = 0.4;
// Predict enemy-projectile trajectories far enough ahead to sidestep both direct
// shots and fireball splash without abandoning the current combat target.
export const PROJECTILE_DODGE_HORIZON_FRAMES = 90;
export const PROJECTILE_DODGE_CLEARANCE_FT = 2.5;
export const PROJECTILE_DODGE_AOE_BUFFER_FT = 1.5;
// Track-B's default dodge weight is intentionally modest for moving enemies. A
// collision-course projectile needs a decisive lateral step, so scale only that
// dodge vector while preserving forward pressure on the engagement target.
export const PROJECTILE_DODGE_VECTOR_SCALE = 3;
// --- On-path loot detour (OpportunisticCollect) ---
// Rule (player's words): "if there is loot within 5' of my path and I am not
// actively fighting or dodging enemies, make the slight detour to grab it."
//
// "My path" is the ray from the player along the CURRENT heading (previous-frame
// smoothed output). A loot qualifies for a detour pull only if it lies AHEAD of
// the player (positive projection onto the heading) AND its perpendicular
// distance to that path ray is within PATH_CORRIDOR_HALF_WIDTH_FT. This narrow
// forward corridor is the key difference from the reverted omnidirectional pull:
// by ignoring loot behind or far to the side of the travel direction, the detour
// stays genuinely "slight" and cannot systematically bias the net exploration
// trajectory toward off-path loot-dense (= enemy-dense) zones — the regression
// that previously forced collectPullWeight to 0.0 and blew the headless
// floor-clear budget.
//
// 9 feet of lateral slack from the path ray. Wide enough that the player scoops
// up gems/gold/items it strolls past while navigating (the corridor was 5 ft,
// which left gathering almost dormant), but still narrow enough that the detour
// stays "slight" and cannot bias the net trajectory toward off-path loot.
export const PATH_CORRIDOR_HALF_WIDTH_FT = 7;
// Below this heading magnitude the player has no meaningful travel direction
// (effectively stationary), so the path ray is undefined and the detour is
// skipped — pickups while standing still are handled by Track A's Collect
// behavior, not the opportunistic detour.
export const DETOUR_MIN_HEADING_MAGNITUDE = 0.05;
// --- Opportunistic enemy-farm (forward bias) ---
// Scan radius (ft) for the on-path enemy-farm pull. An enemy must be within this
// range AND roughly ahead of the player's heading to draw a pull, so the player
// drifts onto swarm it is already approaching rather than reversing toward
// enemies behind it.
export const FARM_FORWARD_SCAN_RADIUS_FT = 28;
// An enemy counts as "ahead" only when its forward projection covers at least
// this fraction of the distance to it (cos of the half-angle). Keeps the farm
// pull inside a forward cone so it never drags the player sideways/backward.
export const FARM_FORWARD_DOT_MIN = 0.35;
// Opportunistic farming is for surplus time, not survival: suppress the pull when
// the player is below this health fraction so a hurt runner beelines its objective
// (and dodges) instead of drifting onto more swarm and getting overwhelmed — the
// over-engagement death mode the forward bias must never reintroduce.
export const FARM_MIN_HEALTH_FRACTION = 0.6;
// --- Collapse-pressure panic routing ---
// Remaining-time threshold for hard beeline behavior. At or below this value the
// AI drops opportunistic loot/farm detours and commits to objective progress.
export const PANIC_BEELINE_REMAINING_MS = 60_000;
// Panic pressure ramps in from this remaining-time mark down to
// PANIC_BEELINE_REMAINING_MS, increasing risk tolerance as collapse nears.
export const PANIC_RAMP_START_REMAINING_MS = 180_000;
// Pressure boost while stairs are still locked: if the player is behind on the
// unlock chain, panic escalates faster for the same remaining time.
export const PANIC_LOCKED_STAIRS_MULTIPLIER = 1.35;
// Lower bound for dodge-weight scaling under panic. Keep > 0 so emergency beelines
// still perform some evasive movement rather than pure face-tanking.
export const PANIC_MIN_DODGE_WEIGHT_SCALE = 0.45;
// Pre-unlock emergency floor for dodge scaling. Slightly lower than the generic
// floor so low-time, pre-unlock runs prioritize progress over perfect safety.
export const PANIC_MIN_DODGE_WEIGHT_SCALE_LOCKED = 0.3;
// Additive safety margin, in milliseconds, layered on top of the AI's
// deterministic player→stairs travel-time estimate before it becomes the
// panic-beeline threshold. Small buffer that covers steering wobble, door
// interactions, and the last-tile marker-radius approach so a run that just
// killed the final boss cannot be caught out by a slightly-too-tight estimate.
export const PANIC_STAIRS_TRAVEL_SAFETY_MS = 5_000;
// Wall-safety inflation factor applied to raw straight-line distance when the
// A* tile path is unavailable (unit tests, unusual world states). Real Floor-1
// layouts add 30–70% to the Euclidean distance for typical player→stairs
// routes, so 1.5x is a defensive fallback that keeps the estimate honest.
export const OBJECTIVE_TRAVEL_WALL_SAFETY_FACTOR = 1.5;
// Fixed additive buffer, in milliseconds, layered on the wall-safety fallback
// so it always exceeds the raw straight-line planner travel time even for very
// short distances where the multiplier alone barely bumps the estimate.
export const OBJECTIVE_TRAVEL_WALL_SAFETY_BUFFER_MS = 750;
// A* path recomputes are throttled to this many BT ticks (~250ms at the
// default 60 FPS BT cadence). Frame count is deterministic, so this stays
// deterministic; the throttle keeps the cost of `findTilePath` bounded while
// still refreshing quickly enough to react to the boss dying / doors opening.
export const OBJECTIVE_TRAVEL_ASTAR_REFRESH_TICKS = 15;

// --- Time-aware run planner -------------------------------------------------
// Coarse, deterministic estimates only: they bias optional-value decisions, never
// select objectives. The BT/Floor 1 quest state remains authoritative.
export const RUN_PLANNER_SAFETY_BUFFER_MS = 20_000;
export const RUN_PLANNER_URGENCY_SLACK_WINDOW_MS = 120_000;
export const RUN_PLANNER_INTERACTION_MS = 1_500;
export const RUN_PLANNER_LEVEL_2_GRIND_MS = 35_000;
export const RUN_PLANNER_QUEST_KILL_MS = 4_500;
export const RUN_PLANNER_GOLD_FARM_MS = 3_000;
export const RUN_PLANNER_FETCH_PICKUP_MS = 1_000;
export const RUN_PLANNER_MINOR_BOSS_KILL_MS = 25_000;
export const RUN_PLANNER_FINAL_BOSS_KILL_MS = 45_000;
export const RUN_PLANNER_STAIRS_INTERACT_MS = 1_000;

// --- Tactical opportunities during objective travel ------------------------
// Pickup opportunities are filtered by reachability first, then ranked by
// path-relative detour cost. Enemy packs are scored for debug only in this slice.
export const TACTICAL_OPPORTUNITY_SCAN_RADIUS_FT = 24;
// Max detour (ft) a pickup may add to the current objective leg. Measured over
// the 72-run Floor-1 gate matrix (seeds 1-24 x sword/bow/baseball-bat) on top of
// the 12ft mid-run loot sweep:
//    8ft -> 72/72 wins, combined collection 0.7919, mean floor 258.4s
//   12ft -> 70/72 wins, combined collection 0.7854, mean floor 260.0s
// Widening it does NOT collect more: it trades on-path gems for longer errands
// (mean level rises but two runs are lost to a deadline timeout and a death), so
// 8ft stays. Rule 12 gates on win-RATE first.
export const TACTICAL_OPPORTUNITY_MAX_DETOUR_FT = 8;
export const TACTICAL_OPPORTUNITY_TRIVIAL_DETOUR_FT = 0.75;
export const TACTICAL_OPPORTUNITY_MIN_DETOUR_MS = 250;
export const TACTICAL_OPPORTUNITY_URGENCY_PENALTY = 0.95;
export const TACTICAL_OPPORTUNITY_DANGER_PENALTY = 1.5;
export const TACTICAL_OPPORTUNITY_ACCEPT_SCORE = 2;
export const TACTICAL_OPPORTUNITY_MAX_ACCEPTED = 4;
export const TACTICAL_OPPORTUNITY_TRAVEL_WEIGHT_DIVISOR = 8;
export const TACTICAL_OPPORTUNITY_MAX_TRAVEL_WEIGHT = 2;
export const TACTICAL_TRAVEL_W_LOOT = 1.15;
export const TACTICAL_OPPORTUNITY_GOLD_VALUE = 3;
export const TACTICAL_OPPORTUNITY_ITEM_VALUE = 18;
export const TACTICAL_OPPORTUNITY_ENEMY_PACK_MIN_VALUE = 1;
export const TACTICAL_OPPORTUNITY_ENEMY_PACK_BASE_VALUE = 8;
export const TACTICAL_OPPORTUNITY_ENEMY_PACK_HP_PENALTY = 0.15;

// Opportunistic quest-NPC detour while pathing: if an NPC with a pending quest
// interaction is seen and visiting it adds only a small path-length penalty,
// route Progress to that NPC first so interactions are not skipped while
// traversing toward combat/room objectives. Distances are in feet (the internal
// spatial unit): allow up to ~20 ft of extra path, or 0.5x the direct distance,
// whichever is larger.
export const QUEST_GIVER_DETOUR_MAX_EXTRA_FT = 26;
export const QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION = 0.6;
// Once a quest-giver detour has already been ACCEPTED (a committed NPC), tolerate
// a relaxed detour cap of `baseCap * this` before abandoning it. Without this,
// tiny per-frame distance changes at the safe-room-mouth boundary — where
// `world.playerInSafeRoom` flickers as the body straddles the doorway — flip the
// selected objective every frame and pin the runner in a net-zero limit cycle.
// Only relaxes the cap for the already-committed path; brand-new detours still use
// the strict base cap. Stale-commit lifetime is independently bounded by
// QUEST_GIVER_DETOUR_ABANDON_FRAMES, so this can be generous without stranding.
export const QUEST_GIVER_DETOUR_COMMIT_HYSTERESIS = 1.5;
// Abandon a committed quest-giver detour once the no-progress frame count EXCEEDS
// this many consecutive frames (strict `>`): exactly this many no-improvement
// frames are tolerated and the release fires on the very next one. Releases a
// body-blocked / locked-door /
// otherwise-unreachable committed NPC well under the floor-collapse deadline so a
// single sticky commitment cannot itself pin the runner for more than ~5s. This
// clears the CURRENT commitment only — it does not blacklist the NPC, so if it
// stays the nearest on-path candidate under the strict base cap, the fresh-
// selection path may re-commit it next poll (exactly as the pre-hysteresis
// baseline steered toward it every frame). ~5s at 60fps.
export const QUEST_GIVER_DETOUR_ABANDON_FRAMES = 300;
// An NPC within this radius (ft) of the player counts as "at the interaction
// point"; beyond it the NPC is only a navigation/detour target.
export const NPC_INTERACTION_RADIUS_FT = 12.5;
// Clamp for the "clear a nearby threat before approaching an NPC" check: a threat
// must be within min(engageRadius, this) feet to pre-empt the NPC approach.
export const NPC_APPROACH_THREAT_RADIUS_FT = 8;
// Stop re-entering threat-clear ENGAGE when it has failed to reduce the distance
// to the same NPC for this many consecutive polls. The bypass stays latched until
// the gate exits, so one small improvement cannot restart the same livelock.
// This spans the 120-frame per-enemy give-up window so enemy rotation cannot reset
// the NPC-level valve, but fires before the 300-frame global dwell watchdog.
// ~3s at 60fps.
export const NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES = 180;

// Arena lock-in "add-first" hysteresis. When the AI is locked in a spawner /
// boss arena, an adjacent add gets priority over the objective only if it is
// at least this much closer than the objective. Prevents oscillation between
// spawner and swarm when they are the same distance away, while still letting
// the AI clear a hugging mob before walking through it toward the objective.
// A ~3 ft hysteresis margin — deliberately a bit under the
// CONTACT_SAFE_ORBIT_FT strike band (4.5 ft) so an add must be clearly closer
// than the objective before it steals priority, rather than merely sharing the
// same strike band. The value is chosen directly, not derived from
// CONTACT_SAFE_ORBIT_FT.
export const ARENA_LOCKIN_ADD_HYSTERESIS_FT = 3;
// In a sealed boss room, a wounded player must clear an add that is already
// inside this pressure radius even when the boss is equally close. The ordinary
// relative-distance hysteresis still governs healthy play.
export const ARENA_LOCKIN_DEFENSIVE_HP_FRACTION = 0.6;
export const ARENA_LOCKIN_ADD_PRESSURE_FT = CONTACT_SAFE_ORBIT_FT * 2;

// --- Predictive safe-gap travel steering (travel-steering.ts) ---
// Replaces the additive single-closest-threat "dodge nudge" during travel with a
// context-steering controller that fans out candidate headings around the
// objective direction and picks the safest forward-progressing arc. This
// generalizes the excellent ENGAGE kite's spacing philosophy to travel so the
// runner *dances around* mobs instead of bulldozing through them. Damage-agnostic
// (nothing here scales with hostile damage) — see the review ledger 2026-07-02.
//
// Master switch: when false the wrapper is skipped and the legacy additive dodge
// path runs unchanged (safe rollback without deleting code).
export const TRAVEL_STEERING_ENABLED = true;
// Combined contact radius (player + enemy half-extents) used to convert predicted
// centre-to-centre distances into true surface (edge-to-edge) clearances. Anchored
// to the AI's existing contact model so travel spacing agrees with ENGAGE.
export const TRAVEL_BODY_RADIUS_FT = MIN_PLAYER_ENEMY_CONTACT_FT;
// Surface gaps (edge-to-edge feet). Below HARD = contact imminent (steep penalty);
// SAFE is the spacing the runner keeps while travelling. Anchored to the proven
// ENGAGE kite, which orbits mobs at CONTACT_SAFE_ORBIT_FT (4.5) and dodges superbly
// — travel reuses that spacing philosophy rather than brushing bodies. The runner
// is ~2.5x faster than mobs, so holding a real gap costs little (it re-plans every
// frame and resumes the beeline the instant the lane clears); the earlier, wider
// arc is what actually sheds contact damage. COMFORT biases toward extra room when
// otherwise indifferent. Clear-time may rise for a safer, richer win — that is an
// explicit design goal, not a regression (only missing the floor collapse is).
// Surface gaps (edge-to-edge feet). HARD is the true "never overlap" floor: the
// thread-past pass (see pickSafeTravelHeading) only ever commits to lanes whose
// predicted gap stays ≥ HARD, so HARD must be wide enough to absorb one frame of
// closing speed + discretisation error (~1 ft) and reliably avoid body contact —
// contact damage is binary at overlap, so keeping gap ≥ HARD is what actually
// shrinks damage taken, independent of the damage multiplier. SAFE is the comfort
// standoff the runner tries to keep while travelling and the beeline-accept
// threshold: it stays on the EXACT objective beeline whenever the beeline's
// predicted gap ≥ SAFE (beeline short-circuit), so SAFE is the deviation knob —
// smaller SAFE ⇒ leave the beeline only when a brush is closer, preserving the
// baseline trajectory/win-rate; larger SAFE ⇒ arc earlier/wider (more damage shed,
// more detour time). Kept modest because the runner is faster and re-plans every
// frame, so it needs little buffer. Crucially, leaving the beeline now means
// threading FORWARD past the mob (Pass 2), not backing away, so the time cost of a
// slightly larger SAFE is small — no more radial-retreat limit cycle. The panic
// ramp (computeTravelSteering) eases SAFE toward HARD as the collapse deadline nears.
export const TRAVEL_HARD_GAP_FT = 1.5;
export const TRAVEL_SAFE_GAP_FT = 1.85;
export const TRAVEL_COMFORT_GAP_FT = 2.5;
// Only threats within this centre distance (feet) are scored. Kept modest so the
// runner reacts to genuinely closing mobs, not distant ones it will never touch —
// reacting early adds detour time that risks the deadline on marginal seeds.
export const TRAVEL_THREAT_RADIUS_FT = 10;
// Closest-approach prediction horizon, frames (~0.27 s at 60 fps). Long enough to
// see an imminent body contact and slip it, short enough not to pre-emptively
// orbit mobs that cannot reach the (faster) runner within the window.
export const TRAVEL_HORIZON_FRAMES = 14;
// Candidate heading offsets from the objective direction, degrees (mirrored ±).
// Fine near objDir (cheap arcs), coarse toward the back (only used in pincers).
export const TRAVEL_CANDIDATE_OFFSETS_DEG: readonly number[] = [
  0, 15, 30, 45, 60, 75, 90, 110, 135, 160, 180,
];
// Wall-probe sample distances along a candidate, feet (ascending). A wall within
// the FIRST step makes the candidate impassable; farther walls are only penalized.
// Probes out to 15 ft so the Pass-2 kite filter (wallPenalty === 0 ⟺ deeply clear)
// can tell a genuine open escape lane from a shallow wall pocket that reads clear
// at 9 ft but dead-ends just beyond — the pocket that re-wedged a doorway at 159 s.
export const TRAVEL_WALL_PROBE_DISTANCES_FT: readonly number[] = [3, 6, 9, 12, 15];
// Minimum progress dot for a candidate to count as "progressing" toward objective.
export const TRAVEL_MIN_SAFE_PROGRESS_DOT = 0.05;
// Scoring weights. Progress dominates unless a real predicted contact is imminent
// (safety term is steep near contact). Continuity yields smooth arcs; kite bias
// arcs *around* the nearest mob like the engage orbit.
export const TRAVEL_W_PROGRESS = 4;
export const TRAVEL_W_SAFETY = 10;
export const TRAVEL_W_CONTINUITY = 0.8;
export const TRAVEL_W_KITE = 1.2;
// Base loot/farm weights stay 0; BehaviorTreeAI enables the loot hook dynamically
// only for reachable, planner-approved tactical pickups so there is still one
// travel-state loot channel.
export const TRAVEL_W_LOOT = 0;
export const TRAVEL_W_FARM = 0;
export const TRAVEL_LOOT_LOOKAHEAD_FT = 12;
export const TRAVEL_LOOT_CORRIDOR_FT = 4;
// Trivial-pickup snap radius (ft). Pickups are collected by body overlap, so the
// corridor loot bias — which only *curves* the travel arc toward loot — routinely
// slides past a gem a foot off the heading without ever touching it: the "walked
// right past free XP while adventuring" behaviour. Inside this radius the runner
// steers straight at the pickup instead, so gems it is already next to are
// actually collected mid-run rather than left for the post-boss sweep (which the
// collapse-panic gate often cancels). Deliberately small: the snap is bounded by
// this distance, so the worst case is a ~5 ft deviation that resolves within a
// few frames, and it is skipped entirely when the direct lane is unsafe/blocked
// or a panic beeline is active.
export const TRAVEL_LOOT_SNAP_FT = 3;
// |Vrel|² below this ⇒ closest-approach is degenerate (truly co-moving); fall back
// to the current separation instead of a spurious projection. Kept far below
// (playerSpeed · small-angle)² so a slow-but-real closing course is never
// misclassified as parallel and short-circuited to the current (larger) gap.
export const TRAVEL_REL_SPEED_EPSILON_SQ = 1e-8;
// COLLECT uses steering only while farther than this from the pickup, so the final
// harvest overlap approach (Track A close-range slide) is left untouched.
export const TRAVEL_COLLECT_MIN_STEER_DIST_FT = CLOSE_APPROACH_DIRECT_FT;

// --- Loot sweep --------------------------------------------------------------
// The AI sweeps loot it has already earned (XP gems and gold) rather than
// walking past it toward the next objective. The sweep fires between Interact
// (Priority 2) and Progress (Priority 3), so it delays objective travel only
// while reachable loot remains and no enemy is in engage range.
//
// Two windows share one node:
//   1. **Post-combat** (any time): only loot within LOOT_SWEEP_RADIUS_FT of the
//      player, i.e. the drops from the fight that just ended. Bounded so the
//      sweep is a local cleanup, never a cross-floor errand.
//   2. **Pre-exit** (staircase unlocked, not yet descended): unbounded radius,
//      because descending destroys every uncollected pickup (scene restart with
//      a fresh entity world), so anything left behind is lost permanently.
//
// Panic threshold: abort the sweep and fall through to Progress (beeline to
// stairs) when collapse panic exceeds this fraction. Calibrated so the sweep
// stays active during the comfortable lull but surrenders in the final 1-min
// crunch period when panic > 0.5 on Floor 1. Floor 2 has no collapse timer so
// panic is always 0 there — the sweep runs until all reachable loot is taken.
export const LOOT_SWEEP_PANIC_THRESHOLD = 0.5;
// Radius (ft) for the mid-run post-combat sweep window. 0 disables mid-run
// sweeping, leaving only the pre-exit (staircase-unlocked) full-floor sweep.
// Measured over the gate matrix (seeds 1-24 x sword/bow/baseball-bat, 72 runs):
//    0ft -> combined collection 0.7795, 71/72 wins
//   12ft -> combined collection 0.7919, 72/72 wins  <- shipped
//   35ft -> combined collection 0.7254, 70/72 wins  (two bat losses)
// A *narrow* mid-run window is strictly better than both: it collects the drops
// of the fight that just ended without turning the sweep into a cross-room
// errand, and it costs no measurable floor time (mean 257.3s -> 258.4s). The
// wide 35ft window is what flipped wins, not mid-run sweeping itself. Rule 12
// gates on win-RATE first; change this only with a fresh 72-run measurement.
export const LOOT_SWEEP_RADIUS_FT = 12;
