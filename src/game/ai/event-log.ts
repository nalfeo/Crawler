/**
 * AI event log — structured per-frame telemetry for the headless runner.
 *
 * The headless runner emits {@link SimEvent} records (sampled snapshots plus
 * annotated transitions). {@link summarizeEvents} reduces a stream of events
 * into digestible "wasted time" metrics (wiggling, idling, stuck episodes,
 * kill cadence) so a human — or a different model acting as a judge — can spot
 * dumb AI behavior without scrolling thousands of raw lines.
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
  | 'den';

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
  /** Frames the AI has been considered "stuck" (movement below threshold). */
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
  /** Total game-time flagged as idle (not moving) (ms). */
  idleMs: number;
  idlePct: number;
  /** Total game-time flagged as stuck (stuckFrames above threshold) (ms). */
  stuckMs: number;
  stuckPct: number;
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
  /** stuckFrames at/above this ⇒ stuck. */
  stuckFrames: number;
  /** Minimum episode duration (ms) to report. */
  minEpisodeMs: number;
  /** Max number of episodes to report per category. */
  maxEpisodes: number;
}

export const DEFAULT_SUMMARY_THRESHOLDS: SummaryThresholds = {
  movingTravelFt: 1.5,
  wiggleEfficiency: 0.35,
  idleTravelFt: 0.1875,
  stuckFrames: 45,
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
  let totalPathTravel = 0;
  let totalNetDisp = 0;

  const wiggleEpisodes: WastedEpisode[] = [];
  const stuckEpisodes: WastedEpisode[] = [];
  let wiggleOpen: WastedEpisode | null = null;
  let stuckOpen: WastedEpisode | null = null;

  const closeEpisode = (open: WastedEpisode | null, sink: WastedEpisode[]): null => {
    if (open && open.durationMs >= thresholds.minEpisodeMs) {
      sink.push(open);
    }
    return null;
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

    const moving = sample.pathTravel >= thresholds.movingTravelFt;
    const efficiency = sample.pathTravel > 0 ? sample.netDisp / sample.pathTravel : 1;
    const isWiggle = moving && efficiency < thresholds.wiggleEfficiency;
    const isIdle = sample.pathTravel < thresholds.idleTravelFt;
    const isStuck = sample.stuckFrames >= thresholds.stuckFrames;

    if (isWiggle) wiggleMs += dt;
    if (isIdle) idleMs += dt;
    if (isStuck) stuckMs += dt;

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

    // Episode tracking (stuck)
    if (isStuck) {
      if (!stuckOpen) {
        stuckOpen = {
          startMs: sample.gameMs,
          endMs: sample.gameMs + dt,
          durationMs: dt,
          state: sample.state,
          reason: sample.reason,
          px: Math.round(sample.px),
          py: Math.round(sample.py),
        };
      } else {
        stuckOpen.endMs = sample.gameMs + dt;
        stuckOpen.durationMs = stuckOpen.endMs - stuckOpen.startMs;
      }
    } else {
      stuckOpen = closeEpisode(stuckOpen, stuckEpisodes);
    }
  }
  closeEpisode(wiggleOpen, wiggleEpisodes);
  closeEpisode(stuckOpen, stuckEpisodes);

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
