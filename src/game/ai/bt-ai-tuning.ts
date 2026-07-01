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
import type { AIConfig } from './types.js';

export const DEFAULT_CONFIG: Required<AIConfig> = {
  seed: 12345,
  aggression: 1,
  retreatThreshold: 0.15,
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
  // sooner on swarm the player walks past. Kept low and forward-biased (see
  // OpportunisticFarm) so Track A's quest path stays dominant and the pull can
  // never drag the player off-objective into an off-path fight — the failure
  // mode that previously forced this to 0.0 and blew the floor-clear budget.
  farmPullWeight: 0.07,
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
// expands the orbit out to the strike gate so it sits just beyond the enemy's own
// attack range (poking from safety) instead of trading blows in the strike band.
// With no passive regen, a wounded AI must still kill to level up and heal, so the
// goal is "keep landing auto-fire hits without getting hit" rather than fleeing.
export const MELEE_DEFENSIVE_HP_FRACTION = 0.4;
// Matches weaponSystem's ATTACK_TARGET_GATE_MULTIPLIER: a melee swing connects out
// to reach*1.5, so this is the outer radius at which kiting can still land hits.
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
// Opportunistic quest-NPC detour while pathing: if an NPC with a pending quest
// interaction is seen and visiting it adds only a small path-length penalty,
// route Progress to that NPC first so interactions are not skipped while
// traversing toward combat/room objectives. Distances are in feet (the internal
// spatial unit): allow up to ~20 ft of extra path, or 0.5x the direct distance,
// whichever is larger.
export const QUEST_GIVER_DETOUR_MAX_EXTRA_FT = 26;
export const QUEST_GIVER_DETOUR_MAX_EXTRA_FRACTION = 0.6;
// An NPC within this radius (ft) of the player counts as "at the interaction
// point"; beyond it the NPC is only a navigation/detour target.
export const NPC_INTERACTION_RADIUS_FT = 12.5;
// Clamp for the "clear a nearby threat before approaching an NPC" check: a threat
// must be within min(engageRadius, this) feet to pre-empt the NPC approach.
export const NPC_APPROACH_THREAT_RADIUS_FT = 8;
