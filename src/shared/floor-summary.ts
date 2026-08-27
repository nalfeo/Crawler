/**
 * Between-floor run summary — the pure model behind the "floor complete"
 * stats screen the presentation layer shows before descending to the next
 * floor.
 *
 * Lives in the leaf layer because everything here is primitives plus the
 * shared {@link CombatEvent} shape: the engine renders these rows, and a lab
 * or test can build the exact same model without Phaser or a live world.
 */
import type { CombatEvent } from './combat-events.js';

/** One labelled stat line on the floor-summary screen. */
export interface FloorSummaryRow {
  readonly label: string;
  readonly value: string;
}

/**
 * Everything the summary needs, already resolved by the caller. Optional
 * fields mean "this run has no such measurement" (e.g. a lab that boots
 * without weapon telemetry) and are omitted from the rows rather than shown
 * as a misleading zero — a real measured `0` is passed as `0` and IS shown.
 */
export interface FloorSummaryInput {
  /** Simulated time spent on the floor (`world.elapsedMs`). */
  readonly elapsedMs: number;
  /** Player-attributed enemy kills on this floor. */
  readonly kills: number;
  /** Player level at floor exit. */
  readonly level: number;
  /** XP earned on this floor (`playerLevel.xp` minus the floor's start XP). */
  readonly xpGained: number;
  /** Gold picked up/awarded on this floor (per-floor gold ledger). */
  readonly goldEarned: number;
  /** Gold the player still holds (carries into the next floor). */
  readonly goldHeld: number;
  /** Current player health at floor exit. */
  readonly currentHealth: number;
  /** Max player health at floor exit. Non-positive → the health row is omitted. */
  readonly maxHealth: number;
  /** Weapon accuracy 0..1, when weapon telemetry was recorded. */
  readonly accuracy?: number;
}

/** Formats a simulated duration as `m:ss` (hours roll into minutes). */
export function formatFloorClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Formats a 0..1 ratio as a whole-percent string. */
function formatPercent(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

/**
 * Builds the ordered stat rows for the floor-summary screen. Pure: same input
 * always yields the same rows, so the copy is unit-testable without a scene.
 */
export function buildFloorSummaryRows(input: FloorSummaryInput): FloorSummaryRow[] {
  const rows: FloorSummaryRow[] = [
    { label: 'Time on floor', value: formatFloorClock(input.elapsedMs) },
    { label: 'Enemies slain', value: `${Math.max(0, Math.trunc(input.kills))}` },
    {
      label: 'Level',
      value: `${input.level} (+${Math.max(0, Math.trunc(input.xpGained))} XP)`,
    },
    {
      label: 'Gold',
      value: `+${Math.max(0, Math.trunc(input.goldEarned))} earned · ${Math.max(
        0,
        Math.trunc(input.goldHeld),
      )} held`,
    },
  ];
  if (input.accuracy !== undefined) {
    rows.push({ label: 'Weapon accuracy', value: formatPercent(input.accuracy) });
  }
  if (input.maxHealth > 0) {
    rows.push({
      label: 'Health remaining',
      value: `${formatPercent(input.currentHealth / input.maxHealth)} (${Math.max(
        0,
        Math.round(input.currentHealth),
      )}/${Math.round(input.maxHealth)})`,
    });
  }
  return rows;
}

/**
 * Renders the rows as a monospace-friendly block, one `label   value` line
 * each with the values left-aligned in a single column.
 */
export function formatFloorSummaryText(rows: readonly FloorSummaryRow[]): string {
  const labelWidth = rows.reduce((widest, row) => Math.max(widest, row.label.length), 0);
  return rows.map((row) => `${row.label.padEnd(labelWidth)}   ${row.value}`).join('\n');
}

/**
 * Counts player-attributed enemy deaths in `events` starting at `fromIndex`.
 *
 * Uses the SAME predicate as the canonical run-stats collector (a `death`
 * event whose `targetType` is `enemy` and whose `sourceEid` is the player), so
 * a floor summary and a run bundle can never disagree about kill count.
 *
 * `fromIndex` exists because the render layer drains `world.combatEvents`
 * once per rendered frame while the fixed-step loop may run several steps per
 * frame: the caller passes the queue length captured BEFORE a simulation step
 * so each event is counted exactly once.
 */
export function countPlayerAttributedKills(
  events: readonly CombatEvent[],
  playerEid: number,
  fromIndex = 0,
): number {
  if (playerEid < 0) {
    return 0;
  }
  let kills = 0;
  for (let i = Math.max(0, fromIndex); i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type === 'death' && event.targetType === 'enemy' && event.sourceEid === playerEid) {
      kills += 1;
    }
  }
  return kills;
}
