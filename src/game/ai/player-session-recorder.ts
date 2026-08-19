/**
 * Player session recorder — captures real human-player telemetry at the same
 * fidelity as the headless AI runner's {@link SimEvent} stream.
 *
 * The recordings are stored as {@link PlayerSessionEvent} arrays (a superset of
 * {@link SimEvent} that adds raw input fields). Because the format is compatible
 * with {@link SimEvent}, all existing analysis utilities — {@link summarizeEvents},
 * {@link eventsToJsonl} — work without modification.
 *
 * The recorder is lightweight enough for the dev build and can be injected by
 * labs or the production bootstrap through `MainGameScene` options.
 *
 * Pure module: no Phaser imports. Safe to import from labs and tests.
 */
import { query } from 'bitecs';
import { Enemy } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { createWeaponTelemetry, summarizeWeaponTelemetry } from '../../core/weapon-telemetry.js';
import type { InputState } from '../../shared/input.js';
import type {
  SessionController,
  SessionRecorder,
  SessionRecorderStats,
} from '../../shared/session-recorder-types.js';
import { AI_STATE_NAME, type SimEvent, type SimEventType } from './event-log.js';
import type { BossEncounterSnapshot } from './event-log.js';
import {
  captureBossEncounterSnapshots,
  diffBossEncounterSnapshots,
} from './boss-encounter-telemetry.js';

// ---------------------------------------------------------------------------
// PlayerSessionEvent
// ---------------------------------------------------------------------------

/**
 * A single per-frame telemetry record from a real human player session.
 *
 * Extends {@link SimEvent} with raw input fields so that AI tuning can directly
 * compare human input signals with the AI's computed inputs.
 *
 * The `state` field carries the inferred behavioral label (EXPLORE/ENGAGE/COLLECT/IDLE)
 * for `sample` and `state` records, and for quest-log-derived `quest` records.
 * Event records (`kill`, `levelup`, `npc`) keep the base `'HUMAN'` value from
 * `buildEvent` since those events are not tied to a specific movement state.
 */
export interface PlayerSessionEvent extends SimEvent {
  /** Normalized move X (-1…1) from player input this frame. */
  inputMoveX: number;
  /** Normalized move Y (-1…1) from player input this frame. */
  inputMoveY: number;
  /** Whether the attack/action button was held this frame. */
  inputAction: boolean;
  /** Pointer world X (ft) — where the player aimed. */
  inputPointerX: number;
  /** Pointer world Y (ft) — where the player aimed. */
  inputPointerY: number;
  /** Which controller produced this record — `'AI'` or `'MANUAL'`. */
  controller: SessionController;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Options for {@link createPlayerSessionRecorder}. */
export interface SessionRecorderOptions {
  /** Frames between periodic `sample` events (default 15, ~4 Hz at 60 fps). */
  sampleInterval?: number;
  /**
   * Which controller is driving the player when recording starts (default
   * `'MANUAL'`). The AI Runner lab passes `'AI'` since the behavior-tree runner
   * drives by default there; a human-only lab leaves the default.
   */
  initialController?: SessionController;
  /**
   * Opt in to per-run weapon telemetry (swings, connecting hits, accuracy,
   * multi-hit rate) for this human session. When set, the recorder installs a
   * collector on `world.weaponTelemetry` (if one is not already present) so the
   * player's attacks are measured exactly like the headless runner's
   * `recordWeaponTelemetry` path. Default `false` → zero behavior/allocation cost.
   */
  recordWeaponTelemetry?: boolean;
}

/**
 * A running recorder attached to a single player entity in a {@link GameWorld}.
 *
 * Extends the shared {@link SessionRecorder} interface (engine-visible) with
 * typed event access and JSONL serialization.
 *
 * Typical usage:
 * ```ts
 * const rec = createPlayerSessionRecorder(world, playerEid);
 * // each simulation step:
 * rec.tick(inputState);
 * // on game events:
 * rec.onKill(1);
 * rec.onLevelUp(newLevel);
 * rec.onQuestEvent('main quest accepted');
 * // at session end:
 * rec.download();
 * ```
 */
export interface PlayerSessionRecorder extends SessionRecorder {
  /** Return a read-only snapshot of all recorded events. */
  getEvents(): readonly PlayerSessionEvent[];
  /** Serialize events as JSONL (one JSON object per line). */
  toJsonl(): string;
}

/**
 * Create a {@link PlayerSessionRecorder} bound to the given world and player
 * entity. The recorder reads world state and enemy positions each frame to
 * build telemetry events that mirror the headless runner's output.
 */
export function createPlayerSessionRecorder(
  world: GameWorld,
  playerEid: number,
  options: SessionRecorderOptions = {},
): PlayerSessionRecorder {
  const sampleInterval = Math.max(1, options.sampleInterval ?? 15);
  const initialController: SessionController = options.initialController ?? 'MANUAL';
  const events: PlayerSessionEvent[] = [];
  const recordWeaponTelemetry = options.recordWeaponTelemetry === true;

  // Opt-in weapon telemetry: install a collector on the world so the player's
  // attacks are measured. Reuse an existing collector if one is already present
  // (e.g. the lab enabled it) so we never clobber in-flight counts.
  if (recordWeaponTelemetry && world.weaponTelemetry === undefined) {
    world.weaponTelemetry = createWeaponTelemetry();
  }

  let frameCount = 0;
  let totalKills = 0;
  let lastLoggedState = '';
  let currentController: SessionController = initialController;
  const initialHealthMax = world.stores.health.max[playerEid] ?? 0;
  const initialHealthCurrent = world.stores.health.current[playerEid] ?? 0;
  const initialHealthPercent = initialHealthMax > 0 ? initialHealthCurrent / initialHealthMax : 0;
  let minHealthPercent = initialHealthPercent;
  let closeCallCount = 0;
  let lowHealthCount = 0;
  let lastHealthPercent = initialHealthPercent;

  // Movement-window tracking (mirrors headless runner).
  let lastSampleX = world.stores.position.x[playerEid] ?? 0;
  let lastSampleY = world.stores.position.y[playerEid] ?? 0;
  let lastFrameX = lastSampleX;
  let lastFrameY = lastSampleY;
  let pathTravelAccum = 0;

  // Quest log mirror (tracks first-seen and first-completion per quest).
  const questLogSeen = new Set<string>();
  const questLogCompleted = new Set<string>();

  // Boss-encounter diagnostics. Sampled alongside `sample` records and diffed
  // every frame so den-softlock transitions get exact frame numbers.
  let lastBossSnapshots: BossEncounterSnapshot[] = [];

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function buildEvent(
    type: SimEventType,
    inputState: InputState,
    enemyEids: ArrayLike<number> & Iterable<number>,
    note?: string,
  ): PlayerSessionEvent {
    const px = world.stores.position.x[playerEid] ?? 0;
    const py = world.stores.position.y[playerEid] ?? 0;

    let nearestEnemyDist: number | null = null;
    for (const eid of enemyEids) {
      const ex = world.stores.position.x[eid] ?? 0;
      const ey = world.stores.position.y[eid] ?? 0;
      const dist = Math.hypot(ex - px, ey - py);
      if (nearestEnemyDist === null || dist < nearestEnemyDist) {
        nearestEnemyDist = dist;
      }
    }

    const netDisp = Math.hypot(px - lastSampleX, py - lastSampleY);

    const base: SimEvent = {
      type,
      frame: frameCount,
      gameMs: world.elapsedMs,
      px: Math.round(px),
      py: Math.round(py),
      state: 'HUMAN',
      reason: 'player-input',
      targetEid: null,
      targetDist: null,
      enemyCount: enemyEids.length,
      nearestEnemyDist: nearestEnemyDist === null ? null : Math.round(nearestEnemyDist),
      level: world.playerLevel?.level ?? 0,
      xp: world.playerLevel?.xp ?? 0,
      kills: totalKills,
      health: Math.round(world.stores.health.current[playerEid] ?? 0),
      stuckFrames: 0,
      pathLen: 0,
      netDisp: Math.round(netDisp),
      pathTravel: Math.round(pathTravelAccum),
      ...(note ? { note } : {}),
    };

    return {
      ...base,
      inputMoveX: inputState.moveX,
      inputMoveY: inputState.moveY,
      inputAction: inputState.action,
      inputPointerX: Math.round(inputState.pointerX),
      inputPointerY: Math.round(inputState.pointerY),
      controller: currentController,
    };
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  function tick(inputState: InputState): void {
    frameCount += 1;

    const healthMax = world.stores.health.max[playerEid] ?? 0;
    const healthCurrent = world.stores.health.current[playerEid] ?? 0;
    const healthPercent = healthMax > 0 ? healthCurrent / healthMax : 0;
    if (healthPercent < minHealthPercent) {
      minHealthPercent = healthPercent;
    }
    if (healthPercent < 0.2 && lastHealthPercent >= 0.2) {
      closeCallCount += 1;
    }
    if (healthPercent < 0.5 && lastHealthPercent >= 0.5) {
      lowHealthCount += 1;
    }
    lastHealthPercent = healthPercent;

    const px = world.stores.position.x[playerEid] ?? lastFrameX;
    const py = world.stores.position.y[playerEid] ?? lastFrameY;
    pathTravelAccum += Math.hypot(px - lastFrameX, py - lastFrameY);
    lastFrameX = px;
    lastFrameY = py;

    const enemyEids = query(world.ecs, [Enemy]);

    // Behavioral state label — human sessions use directional hints inferred
    // from input so that state-time summaries still carry meaning.
    const inputMagnitude = Math.hypot(inputState.moveX, inputState.moveY);
    const inferredState = inferHumanState(inputMagnitude, inputState.action, enemyEids.length > 0);

    if (inferredState !== lastLoggedState) {
      const event = buildEvent('state', inputState, enemyEids, `state -> ${inferredState}`);
      event.state = inferredState;
      events.push(event);
      lastLoggedState = inferredState;
    }

    // Boss-encounter diagnostics: emit a discrete `boss` record on every
    // interesting transition (encounter start/defeat, boss leaving or returning
    // to its den, door lock flipping) so a softlock has an exact frame in the
    // log rather than only showing up between periodic samples.
    const bossSnapshots = captureBossEncounterSnapshots(world, playerEid);
    if (bossSnapshots.length > 0) {
      for (const note of diffBossEncounterSnapshots(lastBossSnapshots, bossSnapshots)) {
        const event = buildEvent('boss', inputState, enemyEids, note);
        event.state = inferredState;
        event.reason = 'boss-encounter';
        event.bossEncounters = bossSnapshots;
        events.push(event);
      }
    }
    lastBossSnapshots = bossSnapshots;

    if (frameCount % sampleInterval === 0) {
      const event = buildEvent('sample', inputState, enemyEids);
      event.state = inferredState;
      if (bossSnapshots.length > 0) {
        event.bossEncounters = bossSnapshots;
      }
      events.push(event);
      // Reset per-sample window.
      pathTravelAccum = 0;
      lastSampleX = world.stores.position.x[playerEid] ?? lastSampleX;
      lastSampleY = world.stores.position.y[playerEid] ?? lastSampleY;
    }

    // Quest log tracking (mirrors headless runner).
    for (const [questId, questState] of world.questLog) {
      if (!questLogSeen.has(questId)) {
        questLogSeen.add(questId);
        const event = buildEvent('quest', inputState, enemyEids, `questlog accepted: ${questId}`);
        event.state = inferredState;
        events.push(event);
      }
      if (questState.status === 'complete' && !questLogCompleted.has(questId)) {
        questLogCompleted.add(questId);
        const event = buildEvent('quest', inputState, enemyEids, `questlog completed: ${questId}`);
        event.state = inferredState;
        events.push(event);
      }
    }
  }

  function onKill(killIndex: number): void {
    totalKills += 1;
    const enemyEids = query(world.ecs, [Enemy]);
    const noInput: InputState = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };
    const event = buildEvent('kill', noInput, enemyEids, `kill ${killIndex}`);
    events.push(event);
  }

  function onLevelUp(level: number): void {
    const enemyEids = query(world.ecs, [Enemy]);
    const noInput: InputState = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };
    const event = buildEvent('levelup', noInput, enemyEids, `reached level ${level}`);
    events.push(event);
  }

  function onQuestEvent(note: string): void {
    const enemyEids = query(world.ecs, [Enemy]);
    const noInput: InputState = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };
    const event = buildEvent('quest', noInput, enemyEids, note);
    events.push(event);
  }

  function onNpcEvent(note: string): void {
    const enemyEids = query(world.ecs, [Enemy]);
    const noInput: InputState = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };
    const event = buildEvent('npc', noInput, enemyEids, note);
    events.push(event);
  }

  function onControlChange(controller: SessionController, note?: string): void {
    if (controller === currentController) {
      return;
    }
    currentController = controller;
    const enemyEids = query(world.ecs, [Enemy]);
    const noInput: InputState = { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0 };
    // buildEvent stamps the freshly-updated controller, so the handover record
    // itself is tagged with the controller now taking over.
    const event = buildEvent('control', noInput, enemyEids, note ?? `control -> ${controller}`);
    event.state = controller;
    event.reason = 'control-change';
    events.push(event);
  }

  function getEvents(): readonly PlayerSessionEvent[] {
    return events;
  }

  function getStats(): SessionRecorderStats {
    const samples = events.filter((e) => e.type === 'sample');
    const kills = events.filter((e) => e.type === 'kill');
    const firstMs = samples[0]?.gameMs ?? 0;
    const lastMs = samples[samples.length - 1]?.gameMs ?? firstMs;
    return {
      totalEvents: events.length,
      totalSamples: samples.length,
      totalKills: kills.length,
      durationMs: Math.max(0, lastMs - firstMs),
      minHealthPercent,
      closeCallCount,
      lowHealthCount,
      controller: currentController,
      // Only surface telemetry when THIS recorder opted in — a recorder that did
      // not request telemetry must not report a collector installed elsewhere
      // (e.g. a lab or the headless runner sharing the world).
      ...(recordWeaponTelemetry && world.weaponTelemetry
        ? { weaponTelemetry: summarizeWeaponTelemetry(world.weaponTelemetry) }
        : {}),
    };
  }

  function toJsonl(): string {
    return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  }

  function download(filename?: string): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = filename ?? `session-${ts}.jsonl`;
    const blob = new Blob([toJsonl()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function reset(): void {
    events.length = 0;
    frameCount = 0;
    totalKills = 0;
    lastLoggedState = '';
    const resetHealthMax = world.stores.health.max[playerEid] ?? 0;
    const resetHealthCurrent = world.stores.health.current[playerEid] ?? 0;
    const resetHealthPercent = resetHealthMax > 0 ? resetHealthCurrent / resetHealthMax : 0;
    minHealthPercent = resetHealthPercent;
    closeCallCount = 0;
    lowHealthCount = 0;
    lastHealthPercent = resetHealthPercent;
    // Deliberately preserve currentController: clearing the recorded log does
    // not change who is actually driving the player. The owning lab is the sole
    // authority on the controller (via onControlChange), so reverting to
    // initialController here would silently mis-tag live play after a reset.
    lastSampleX = world.stores.position.x[playerEid] ?? 0;
    lastSampleY = world.stores.position.y[playerEid] ?? 0;
    lastFrameX = lastSampleX;
    lastFrameY = lastSampleY;
    pathTravelAccum = 0;
    questLogSeen.clear();
    questLogCompleted.clear();
    lastBossSnapshots = [];
  }

  return {
    tick,
    onKill,
    onLevelUp,
    onQuestEvent,
    onNpcEvent,
    onControlChange,
    getEvents,
    getStats,
    toJsonl,
    download,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infer a human-readable behavioral state from raw input signals.
 *
 * This mirrors the AI's {@link AI_STATE_NAME} vocabulary so that human and AI
 * event streams can be compared side-by-side with the same summarizeEvents()
 * metrics.
 */
function inferHumanState(inputMagnitude: number, action: boolean, enemiesPresent: boolean): string {
  if (action && enemiesPresent) return AI_STATE_NAME[1]; // ENGAGE
  if (action) return AI_STATE_NAME[3]; // COLLECT (using action with no enemies → picking up)
  if (inputMagnitude > 0.1) return AI_STATE_NAME[0]; // EXPLORE (moving)
  return 'IDLE';
}
