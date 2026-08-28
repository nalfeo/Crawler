/**
 * Unit coverage for the pure between-floor summary model
 * (`src/shared/floor-summary.ts`) that backs the floor-completion stats screen.
 */
import { describe, expect, it } from 'vitest';
import type { CombatEvent } from '../../src/shared/combat-events.js';
import {
  buildFloorSummaryRows,
  countPlayerAttributedKills,
  formatFloorSummaryText,
} from '../../src/shared/floor-summary.js';

const BASE_INPUT = {
  elapsedMs: 125_000,
  kills: 23,
  level: 5,
  xpGained: 412,
  goldEarned: 96,
  goldHeld: 140,
  currentHealth: 34,
  maxHealth: 46,
} as const;

function rowValue(rows: ReturnType<typeof buildFloorSummaryRows>, label: string): string {
  const row = rows.find((entry) => entry.label === label);
  expect(row, `expected a "${label}" row`).toBeDefined();
  return row!.value;
}

function deathEvent(overrides: Partial<CombatEvent> = {}): CombatEvent {
  return {
    type: 'death',
    x: 0,
    y: 0,
    amount: 4,
    targetType: 'enemy',
    timestamp: 0,
    sourceEid: 1,
    ...overrides,
  };
}

describe('floor clock formatting', () => {
  it('renders m:ss with a zero-padded seconds field', () => {
    const clock = (elapsedMs: number): string =>
      rowValue(buildFloorSummaryRows({ ...BASE_INPUT, elapsedMs }), 'Time on floor');
    expect(clock(0)).toBe('0:00');
    expect(clock(9_000)).toBe('0:09');
    expect(clock(65_500)).toBe('1:05');
    expect(clock(3_725_000)).toBe('62:05');
  });

  it('never renders negative time', () => {
    expect(
      rowValue(buildFloorSummaryRows({ ...BASE_INPUT, elapsedMs: -5_000 }), 'Time on floor'),
    ).toBe('0:00');
  });
});

describe('buildFloorSummaryRows', () => {
  it('renders the between-floor stat lines a player reads', () => {
    const rows = buildFloorSummaryRows(BASE_INPUT);
    expect(rowValue(rows, 'Time on floor')).toBe('2:05');
    expect(rowValue(rows, 'Enemies slain')).toBe('23');
    expect(rowValue(rows, 'Level')).toBe('5 (+412 XP)');
    expect(rowValue(rows, 'Gold')).toBe('+96 earned · 140 held');
    expect(rowValue(rows, 'Health remaining')).toBe('74% (34/46)');
  });

  it('shows a genuinely measured zero rather than omitting it', () => {
    const rows = buildFloorSummaryRows({ ...BASE_INPUT, kills: 0, xpGained: 0, accuracy: 0 });
    expect(rowValue(rows, 'Enemies slain')).toBe('0');
    expect(rowValue(rows, 'Level')).toBe('5 (+0 XP)');
    expect(rowValue(rows, 'Weapon accuracy')).toBe('0%');
  });

  it('omits accuracy when no weapon telemetry was recorded', () => {
    const rows = buildFloorSummaryRows(BASE_INPUT);
    expect(rows.some((row) => row.label === 'Weapon accuracy')).toBe(false);
  });

  it('omits the health row when max health is unknown', () => {
    const rows = buildFloorSummaryRows({ ...BASE_INPUT, currentHealth: 0, maxHealth: 0 });
    expect(rows.some((row) => row.label === 'Health remaining')).toBe(false);
  });

  it('clamps accuracy and health ratios into 0..100%', () => {
    const rows = buildFloorSummaryRows({
      ...BASE_INPUT,
      accuracy: 1.4,
      currentHealth: 60,
      maxHealth: 46,
    });
    expect(rowValue(rows, 'Weapon accuracy')).toBe('100%');
    expect(rowValue(rows, 'Health remaining')).toBe('100% (60/46)');
  });
});

describe('formatFloorSummaryText', () => {
  it('aligns every value in one column', () => {
    const lines = formatFloorSummaryText([
      { label: 'Time on floor', value: '2:05' },
      { label: 'Level', value: '5' },
    ]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.indexOf('2:05')).toBe(lines[1]!.indexOf('5'));
  });

  it('is empty for no rows', () => {
    expect(formatFloorSummaryText([])).toBe('');
  });
});

describe('countPlayerAttributedKills', () => {
  const playerEid = 1;

  it('counts only player-attributed enemy deaths', () => {
    const events: CombatEvent[] = [
      deathEvent(),
      deathEvent({ sourceEid: 9 }),
      deathEvent({ targetType: 'player' }),
      deathEvent({ type: 'hit' }),
      deathEvent({ sourceEid: undefined }),
      deathEvent(),
    ];
    expect(countPlayerAttributedKills(events, playerEid)).toBe(2);
  });

  it('counts only events appended after the cursor', () => {
    const events: CombatEvent[] = [deathEvent(), deathEvent(), deathEvent()];
    expect(countPlayerAttributedKills(events, playerEid, 2)).toBe(1);
    expect(countPlayerAttributedKills(events, playerEid, events.length)).toBe(0);
  });

  it('never counts kills before the player entity exists', () => {
    expect(countPlayerAttributedKills([deathEvent({ sourceEid: -1 })], -1)).toBe(0);
  });
});
