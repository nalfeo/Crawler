/**
 * AI event log — structured per-frame telemetry for the headless runner.
 *
 * The headless runner emits {@link SimEvent} records (sampled snapshots plus
 * annotated transitions). {@link summarizeEvents} reduces a stream of events
 * into digestible "wasted time" metrics (wiggling, idling, stuck episodes,
 * kill cadence) so a human — or a different model acting as a judge — can spot
 * dumb AI behavior without scrolling thousands of raw lines.
 *
 * ## The "stuck" / "wiggle" / "idle" / "excluded" definitions (issue #3198)
 *
 * Four mutually-exclusive-per-sample buckets, in priority order:
 *
 * 1. **excluded** — the player is deliberately, legitimately stationary:
 *    inside a safe room (`sample.inSafe`), actively shopping/interacting with
 *    an NPC (`sample.state === 'INTERACT'`), or riding out a dwell-watchdog's
 *    own deliberate suppression window (`sample.state ===
 *    'suppressedProgressNav'` — the watchdog is *already* recovering from a
 *    stuck episode; counting its recovery window as more "stuck" time would
 *    double-count the same defect). Excluded time never counts against the
 *    "stuck or wiggle" budget.
 * 2. **wiggle** — moving a *lot* (`pathTravel >= movingTravelFt` this sample
 *    window) but making little net progress (`netDisp / pathTravel <
 *    wiggleEfficiency`): thrashing/oscillating in place.
 * 3. **idle** — barely moving at all this sample window
 *    (`pathTravel < idleTravelFt`), and not excluded.
 * 4. **stuck** — the headline metric the issue asks to be driven under 1%:
 *    a *sustained* failure to travel farther than a small anchor radius
 *    (see {@link SummaryThresholds.stuckAnchorRadiusFt}) from where the
 *    window began, measured directly from sampled net position (NOT from the
 *    runtime BT's per-frame `stuckFrames` counter, which is a much weaker
 *    signal: at ordinary Floor 2 movement speeds a single frame's
 *    displacement is already below that counter's per-frame epsilon, so it
 *    reads "stuck" during completely normal forward travel — see the
 *    2026-08-21 floor2-wiggle-stuck-repair handoff). A window opens on the
 *    first non-excluded sample — regardless of that sample's own wiggle/idle
 *    classification, so a slow-but-steady crawl that never escapes the
 *    anchor radius still counts — and keeps accumulating while the player
 *    stays within the anchor radius, but none of that time lands
 *    in `stuckMs` until the window's total duration reaches
 *    {@link SummaryThresholds.stuckSustainedMs} ("more than a couple
 *    seconds", per the issue) — a brief combat-positioning pause is normal
 *    play, not a defect. Once a window crosses the threshold it commits in
 *    full (including its grace period) and keeps counting until the player
 *    escapes the radius or hits an excluded sample. `stuckMs` is the single
 *    number to compare against the issue's <1% target; `wiggleMs` / `idleMs`
 *    remain as sub-breakdowns for diagnosis (which flavor of "stuck"
 *    dominates).
 *
 * Pure module: no `fs`, no Phaser. Safe to import from labs and tests.
 */
import { AIState, type AIDecision, type AIDecisionDebug, type AIStateValue } from './types.js';
import type { DenBossEventPayload } from './den-boss-telemetry.js';

/** Human-readable name for each {@link AIState} value. */
export const AI_STATE_NAME: Record<AIStateValue, string> = {
  [AIState.EXPLORE]: 'EXPLORE',
  [AIState.ENGAGE]: 'ENGAGE',
  [AIState.RETREAT]: 'RETREAT',
  [AIState.COLLECT]: 'COLLECT',
  [AIState.INTERACT]: 'INTERACT',
};

/** State label emitted to JSONL/summaries, including telemetry-only refinements. */
export function getDecisionEventState(decision: Pick<AIDecision, 'state' | 'debug'>): string {
  return decision.debug?.state ?? AI_STATE_NAME[decision.state] ?? String(decision.state);
}

/** Discriminator for the kind of telemetry record. */
export type SimEventType =
  | 'sample'
  | 'state'
  | 'kill'
  | 'levelup'
  | 'quest'
  | 'npc'
  | 'control'
  | 'den'
  | 'boss';

/** Per-boss-encounter diagnostic snapshot for Floor 2 den softlocks. */
export interface BossEncounterSnapshot {
  familyId: string;
  displayName: string;
  bossEid: number | null;
  /** True only when `bossEid` still resolves to this family's live boss entity. */
  bossEntityExists: boolean;
  started: boolean;
  defeated: boolean;
  denRoomId: number;
  bossRoomId: number | null;
  bossInDen: boolean | null;
  bossTileX: number | null;
  bossTileY: number | null;
  bossHealth: number | null;
  bossHealthMax: number | null;
  bossVisible: boolean | null;
  activeGoalId: string;
  activeGoalValue: boolean;
  doorsLocked: boolean;
  playerInDen: boolean;
}

/**
 * A single telemetry record. Every record carries the full frame context so
 * each JSONL line is self-contained and independently interpretable.
 */
export interface SimEvent {
  /** Record kind. */
  type: SimEventType;
  /** Simulation frame index. */
  frame: number;
  /** Simulated game time in ms. */
  gameMs: number;
  /** Player world X (ft). */
  px: number;
  /** Player world Y (ft). */
  py: number;
  /** Emitted AI state label; may be a telemetry-only refinement of the base state. */
  state: string;
  /** Coarse gameplay state before telemetry-only refinement, when different. */
  baseState?: string;
  /** Typed decision debug payload that produced a telemetry-only state label. */
  decisionDebug?: AIDecisionDebug | null;
  /** Human-readable reason the AI gave for its decision. */
  reason: string;
  /** Target entity id, if any. */
  targetEid: number | null;
  /** Distance to the AI's chosen target (ft), if any. */
  targetDist: number | null;
  /** Current/max health of the chosen target when it has health. */
  targetHealth?: { current: number; max: number } | null;
  /** Floor-director archetype id of the chosen target, when tracked. */
  targetArchetype?: string | null;
  /** Live enemy count. */
  enemyCount: number;
  /** Distance to nearest enemy (ft), if any. */
  nearestEnemyDist: number | null;
  /** Player level. */
  level: number;
  /** Player XP. */
  xp: number;
  /** Cumulative kills so far. */
  kills: number;
  /** Player health. */
  health: number;
  /**
   * Raw per-frame BT `stuckFrames` counter (frames since the player last
   * moved more than a small epsilon). Retained for low-level diagnostics
   * only — `summarizeEvents`'s `stuckMs`/`stuckEpisodes` do NOT use this
   * field (see the module doc comment): at ordinary movement speeds a single
   * frame's displacement already falls below the runtime epsilon, so this
   * counter reads "stuck" during completely normal forward travel.
   */
  stuckFrames: number;
  /** Remaining waypoints in the current A* path. */
  pathLen: number;
  /** Straight-line displacement since the previous sample (ft). */
  netDisp: number;
  /** Total path distance actually traveled since the previous sample (ft). */
  pathTravel: number;
  /** Remaining time before floor collapse (ms), or null if no floor objective. */
  remainingMs?: number | null;
  /** Whether the player was inside a safe room this sample (deadline paused). */
  inSafe?: boolean;
  /** Run-plan slack (ms) this sample, when travelling under a Floor-1 run plan. */
  slackMs?: number | null;
  /** Run-plan urgency (0..1) this sample, when travelling under a Floor-1 run plan. */
  urgency?: number | null;
  /** A/B decision-mode axis the AI ran under (e.g. 'legacy' | 'slackAware'). */
  decisionMode?: string;
  /**
   * Floor 2 den-boss diagnostic payload. Present on — and only on — `den`
   * records (see {@link isDenSimEvent}). Identical on every telemetry surface:
   * headless `RunStats` runs, AI Runner lab recordings, and real player
   * sessions all emit this same contract.
   */
  denBoss?: DenBossEventPayload;
  /**
   * Boss-encounter diagnostics for this frame. Present on `sample` records and
   * on every `boss` transition record when the floor has den encounters.
   */
  bossEncounters?: BossEncounterSnapshot[];
  /** Optional annotation for non-sample events. */
  note?: string;
}

/** A `den` telemetry record, narrowed so `denBoss` is guaranteed present. */
export type DenSimEvent = SimEvent & { type: 'den'; denBoss: DenBossEventPayload };

/**
 * Type guard for den-boss telemetry records. Use it when reading a recording so
 * the den payload is statically known to exist.
 */
export function isDenSimEvent(event: SimEvent): event is DenSimEvent {
  return event.type === 'den' && event.denBoss !== undefined;
}

/** A contiguous window of flagged "wasted time" behavior. */
export interface WastedEpisode {
  startMs: number;
  endMs: number;
  durationMs: number;
  state: string;
  reason: string;
  /** Representative player position at the start of the episode. */
  px: number;
  py: number;
}

/** Aggregate wasted-time / behavior summary derived from a SimEvent stream. */
export interface EventSummary {
  totalSamples: number;
  durationMs: number;
  finalLevel: number;
  finalXp: number;
  kills: number;
  /** Time of first kill (ms), or null if never. */
  timeToFirstKillMs: number | null;
  /** Game-time of each kill (ms). */
  killTimestampsMs: number[];
  /** Longest stretch with no kills (ms), bounded by run start/end. */
  longestKillGapMs: number | null;
  /** Game-time spent in each AI state (ms). */
  stateMs: Record<string, number>;
  /** Percentage of run time spent in each AI state. */
  statePct: Record<string, number>;
  /** Game-time attributed to each decision reason (ms), top entries. */
  reasonMs: Record<string, number>;
  /** Total game-time flagged as wiggling (moving a lot, going nowhere) (ms). */
  wiggleMs: number;
  wigglePct: number;
  /** Total game-time flagged as idle (barely moving at all) (ms). */
  idleMs: number;
  idlePct: number;
  /**
   * Total game-time flagged as "stuck" — a sustained failure to travel past
   * the anchor radius, computed directly from sampled position (see the
   * module doc comment). This is the single headline metric to compare
   * against the issue's <1% target; `wiggleMs`/`idleMs` are its sub-breakdown.
   */
  stuckMs: number;
  stuckPct: number;
  /**
   * Game-time excluded from wiggle/idle/stuck accounting because the player
   * was legitimately, deliberately stationary: inside a safe room, shopping
   * with an NPC, or riding out a dwell watchdog's own suppression window.
   */
  excludedMs: number;
  excludedPct: number;
  /** Notable wiggle episodes, longest first. */
  wiggleEpisodes: WastedEpisode[];
  /** Notable stuck episodes, longest first. */
  stuckEpisodes: WastedEpisode[];
  /** Total path distance actually traveled across the run (ft). */
  totalPathTravel: number;
  /** Net straight-line displacement summed across samples (ft). */
  totalNetDisp: number;
  /** Overall efficiency: net displacement / path traveled (0..1). */
  travelEfficiency: number;
}

/** Tunables for what counts as wasted motion. Exposed for tests/tuning. */
export interface SummaryThresholds {
  /** Min path travel (ft) in a sample window to consider "actively moving". */
  movingTravelFt: number;
  /** netDisp/pathTravel below this while moving ⇒ wiggle. */
  wiggleEfficiency: number;
  /** Path travel (ft) below this ⇒ idle (not moving). */
  idleTravelFt: number;
  /**
   * Radius (ft) from a "stuck episode" anchor position the player must
   * exceed to be considered no longer stuck. Sustained wiggle/idle samples
   * that never escape this radius accumulate as `stuckMs`. See the module
   * doc comment for why this replaces a per-frame `stuckFrames` threshold.
   */
  stuckAnchorRadiusFt: number;
  /**
   * Minimum contiguous duration (ms) a wiggle/idle run must reach — while
   * staying within `stuckAnchorRadiusFt` — before ANY of it counts toward
   * `stuckMs`. Per the issue's own definition ("not moving very far for more
   * than a couple seconds"), a half-second combat-positioning pause is
   * normal play, not a defect; only a *sustained* failure to progress should
   * count. A run that reaches this threshold counts in full, including its
   * initial grace period (it does not "start counting" only from the
   * threshold onward — the whole sustained window was stuck).
   */
  stuckSustainedMs: number;
  /** Minimum episode duration (ms) to report. */
  minEpisodeMs: number;
  /** Max number of episodes to report per category. */
  maxEpisodes: number;
}

export const DEFAULT_SUMMARY_THRESHOLDS: SummaryThresholds = {
  movingTravelFt: 1.5,
  wiggleEfficiency: 0.35,
  idleTravelFt: 0.1875,
  stuckAnchorRadiusFt: 12,
  stuckSustainedMs: 2000,
  minEpisodeMs: 800,
  maxEpisodes: 12,
};

function topEntries(record: Record<string, number>, limit: number): Record<string, number> {
  const sorted = Object.entries(record).sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  for (const [key, value] of sorted.slice(0, limit)) {
    out[key] = Math.round(value);
  }
  return out;
}

/**
 * Reduce a SimEvent stream into a wasted-time / behavior summary.
 *
 * Time is attributed using the gap between consecutive `sample` events, so the
 * result is sampling-cadence independent. Kill timing is taken from `kill`
 * events.
 */
export function summarizeEvents(
  events: readonly SimEvent[],
  thresholds: SummaryThresholds = DEFAULT_SUMMARY_THRESHOLDS,
): EventSummary {
  const samples = events.filter((event) => event.type === 'sample');
  const kills = events.filter((event) => event.type === 'kill');

  const stateMs: Record<string, number> = {};
  const reasonMs: Record<string, number> = {};
  let wiggleMs = 0;
  let idleMs = 0;
  let stuckMs = 0;
  let excludedMs = 0;
  let totalPathTravel = 0;
  let totalNetDisp = 0;

  const wiggleEpisodes: WastedEpisode[] = [];
  const stuckEpisodes: WastedEpisode[] = [];
  let wiggleOpen: WastedEpisode | null = null;
  // Pending/committed stuck window state. A window opens on the first
  // non-excluded wiggle/idle sample and stays open while the player stays
  // within `stuckAnchorRadiusFt` of the anchor. It only becomes "committed"
  // (added to `stuckMs`, tracked in `stuckOpen`) once its accumulated
  // duration reaches `stuckSustainedMs` — see the doc comment on that field.
  let stuckWindowStartMs = 0;
  let stuckWindowAccumMs = 0;
  let stuckWindowCommitted = false;
  let stuckAnchorX = 0;
  let stuckAnchorY = 0;
  let stuckWindowState = '';
  let stuckWindowReason = '';
  let stuckWindowPx = 0;
  let stuckWindowPy = 0;
  let stuckOpen: WastedEpisode | null = null;

  const closeEpisode = (open: WastedEpisode | null, sink: WastedEpisode[]): null => {
    if (open && open.durationMs >= thresholds.minEpisodeMs) {
      sink.push(open);
    }
    return null;
  };

  /** Close (and possibly commit) the current stuck window, if any. */
  const closeStuckWindow = (): void => {
    if (stuckWindowCommitted) {
      stuckOpen = closeEpisode(stuckOpen, stuckEpisodes);
    }
    stuckWindowAccumMs = 0;
    stuckWindowCommitted = false;
  };

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    totalPathTravel += sample.pathTravel;
    totalNetDisp += sample.netDisp;

    // Time attributed to this sample = gap until the next sample.
    const next = samples[i + 1];
    const dt = next ? Math.max(0, next.gameMs - sample.gameMs) : 0;

    stateMs[sample.state] = (stateMs[sample.state] ?? 0) + dt;
    reasonMs[sample.reason] = (reasonMs[sample.reason] ?? 0) + dt;

    // Deliberately, legitimately stationary — never counts as wasted time.
    // See the module doc comment for why each of these is excluded.
    const isExcluded =
      sample.inSafe === true ||
      sample.state === 'INTERACT' ||
      sample.state === 'suppressedProgressNav';

    const moving = sample.pathTravel >= thresholds.movingTravelFt;
    const efficiency = sample.pathTravel > 0 ? sample.netDisp / sample.pathTravel : 1;
    const isWiggle = !isExcluded && moving && efficiency < thresholds.wiggleEfficiency;
    const isIdle = !isExcluded && sample.pathTravel < thresholds.idleTravelFt;

    if (isExcluded) {
      excludedMs += dt;
    }
    if (isWiggle) wiggleMs += dt;
    if (isIdle) idleMs += dt;

    // Episode tracking (wiggle)
    if (isWiggle) {
      if (!wiggleOpen) {
        wiggleOpen = {
          startMs: sample.gameMs,
          endMs: sample.gameMs + dt,
          durationMs: dt,
          state: sample.state,
          reason: sample.reason,
          px: Math.round(sample.px),
          py: Math.round(sample.py),
        };
      } else {
        wiggleOpen.endMs = sample.gameMs + dt;
        wiggleOpen.durationMs = wiggleOpen.endMs - wiggleOpen.startMs;
      }
    } else {
      wiggleOpen = closeEpisode(wiggleOpen, wiggleEpisodes);
    }

    // "Stuck" is a SUSTAINED failure to travel past the anchor radius,
    // measured directly from sampled position — NOT gated by the wiggle/idle
    // per-sample flags (a sample can fail both the wiggle and idle threshold
    // — e.g. a slow but steady 0.2-1.5ft/sample crawl — and still be part of
    // a sustained failure to leave a small area, which is exactly the "not
    // moving very far for more than a couple seconds" case the issue asks
    // for). A window opens on the first non-excluded sample, anchors to that
    // position, and accumulates for as long as the player stays within the
    // anchor radius — but that time only lands in `stuckMs` once the
    // window's total duration reaches `stuckSustainedMs` ("a couple
    // seconds", per the issue). Escaping the radius, or hitting an excluded
    // sample, closes the window; if it never reached the sustained
    // threshold, none of its time counted at all.
    const candidateStuck = !isExcluded;
    if (candidateStuck) {
      const withinAnchor =
        stuckWindowAccumMs > 0 &&
        Math.hypot(sample.px - stuckAnchorX, sample.py - stuckAnchorY) <=
          thresholds.stuckAnchorRadiusFt;
      if (stuckWindowAccumMs === 0 || !withinAnchor) {
        // Fresh window: either nothing was open, or the player escaped the
        // previous anchor radius (genuine progress) and may now be starting
        // a new stuck window right where they landed.
        closeStuckWindow();
        stuckWindowStartMs = sample.gameMs;
        stuckAnchorX = sample.px;
        stuckAnchorY = sample.py;
        stuckWindowState = sample.state;
        stuckWindowReason = sample.reason;
        stuckWindowPx = Math.round(sample.px);
        stuckWindowPy = Math.round(sample.py);
      }
      stuckWindowAccumMs += dt;
      if (!stuckWindowCommitted && stuckWindowAccumMs >= thresholds.stuckSustainedMs) {
        // Just crossed the sustained threshold: commit the ENTIRE
        // accumulated window (including its initial grace period), not
        // just time from this point onward.
        stuckWindowCommitted = true;
        stuckMs += stuckWindowAccumMs;
        stuckOpen = {
          startMs: stuckWindowStartMs,
          endMs: sample.gameMs + dt,
          durationMs: stuckWindowAccumMs,
          state: stuckWindowState,
          reason: stuckWindowReason,
          px: stuckWindowPx,
          py: stuckWindowPy,
        };
      } else if (stuckWindowCommitted) {
        stuckMs += dt;
        stuckOpen!.endMs = sample.gameMs + dt;
        stuckOpen!.durationMs = stuckOpen!.endMs - stuckOpen!.startMs;
      }
    } else {
      closeStuckWindow();
    }
  }
  closeEpisode(wiggleOpen, wiggleEpisodes);
  closeStuckWindow();

  const firstMs = samples[0]?.gameMs ?? 0;
  const lastMs = samples[samples.length - 1]?.gameMs ?? firstMs;
  const durationMs = Math.max(0, lastMs - firstMs);

  const killTimestampsMs = kills.map((event) => event.gameMs);
  const timeToFirstKillMs = killTimestampsMs.length > 0 ? killTimestampsMs[0]! : null;

  // Longest gap between kills, bounded by [runStart, runEnd].
  let longestKillGapMs: number | null = null;
  if (samples.length > 0) {
    const boundaries = [firstMs, ...killTimestampsMs, lastMs];
    let maxGap = 0;
    for (let i = 1; i < boundaries.length; i += 1) {
      maxGap = Math.max(maxGap, boundaries[i]! - boundaries[i - 1]!);
    }
    longestKillGapMs = maxGap;
  }

  const statePct: Record<string, number> = {};
  for (const [state, ms] of Object.entries(stateMs)) {
    statePct[state] = durationMs > 0 ? Math.round((ms / durationMs) * 1000) / 10 : 0;
  }

  const pct = (ms: number): number =>
    durationMs > 0 ? Math.round((ms / durationMs) * 1000) / 10 : 0;

  wiggleEpisodes.sort((a, b) => b.durationMs - a.durationMs);
  stuckEpisodes.sort((a, b) => b.durationMs - a.durationMs);

  return {
    totalSamples: samples.length,
    durationMs,
    finalLevel: samples[samples.length - 1]?.level ?? 0,
    finalXp: samples[samples.length - 1]?.xp ?? 0,
    kills: kills.length,
    timeToFirstKillMs,
    killTimestampsMs,
    longestKillGapMs,
    stateMs: topEntries(stateMs, 8),
    statePct,
    reasonMs: topEntries(reasonMs, 12),
    wiggleMs: Math.round(wiggleMs),
    wigglePct: pct(wiggleMs),
    idleMs: Math.round(idleMs),
    idlePct: pct(idleMs),
    stuckMs: Math.round(stuckMs),
    stuckPct: pct(stuckMs),
    excludedMs: Math.round(excludedMs),
    excludedPct: pct(excludedMs),
    wiggleEpisodes: wiggleEpisodes.slice(0, thresholds.maxEpisodes),
    stuckEpisodes: stuckEpisodes.slice(0, thresholds.maxEpisodes),
    totalPathTravel: Math.round(totalPathTravel),
    totalNetDisp: Math.round(totalNetDisp),
    travelEfficiency:
      totalPathTravel > 0 ? Math.round((totalNetDisp / totalPathTravel) * 1000) / 1000 : 0,
  };
}

/** Serialize events as JSONL (one JSON object per line). */
export function eventsToJsonl(events: readonly SimEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}
