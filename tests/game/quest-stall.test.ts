import { describe, it, expect } from 'vitest';
import {
  summarizeQuestProgress,
  QuestProgressStallTracker,
  formatQuestStallReason,
} from '../../src/game/ai/quest-stall.js';
import type { QuestState, QuestStatus } from '../../src/shared/quest-types.js';

function makeQuest(questId: string, status: QuestStatus = 'active'): QuestState {
  return { questId, status, tracked: false, progress: {}, done: {} };
}

describe('summarizeQuestProgress', () => {
  it('splits accepted quests into completed and incomplete, preserving order', () => {
    const quests = [
      makeQuest('find-welcome', 'complete'),
      makeQuest('tutorial', 'active'),
      makeQuest('shop', 'complete'),
      makeQuest('boss-battle', 'active'),
    ];
    const summary = summarizeQuestProgress(quests);
    expect(summary.accepted).toEqual(['find-welcome', 'tutorial', 'shop', 'boss-battle']);
    expect(summary.completed).toEqual(['find-welcome', 'shop']);
    expect(summary.incomplete).toEqual(['tutorial', 'boss-battle']);
  });

  it('returns empty lists for an empty quest log', () => {
    const summary = summarizeQuestProgress([]);
    expect(summary.accepted).toEqual([]);
    expect(summary.completed).toEqual([]);
    expect(summary.incomplete).toEqual([]);
  });
});

describe('QuestProgressStallTracker', () => {
  it('never stalls on the first update (baseline seed)', () => {
    const tracker = new QuestProgressStallTracker(100);
    expect(tracker.update(10, 999999)).toBe(false);
  });

  it('stalls only once the score has been frozen for the full window', () => {
    const tracker = new QuestProgressStallTracker(100);
    expect(tracker.update(10, 0)).toBe(false); // seed
    expect(tracker.update(10, 50)).toBe(false);
    expect(tracker.update(10, 99)).toBe(false);
    expect(tracker.update(10, 100)).toBe(true); // exactly at the limit
    expect(tracker.update(10, 200)).toBe(true); // remains stalled until progress
  });

  it('treats an unchanged score as no progress (equal is not improvement)', () => {
    const tracker = new QuestProgressStallTracker(10);
    tracker.update(5, 0);
    expect(tracker.update(5, 10)).toBe(true);
  });

  it('resets the stall window whenever the score improves', () => {
    const tracker = new QuestProgressStallTracker(100);
    expect(tracker.update(10, 0)).toBe(false); // seed
    expect(tracker.update(10, 90)).toBe(false);
    expect(tracker.update(20, 95)).toBe(false); // improvement → window restarts at 95
    expect(tracker.update(20, 190)).toBe(false); // 95 < 100
    expect(tracker.update(20, 195)).toBe(true); // 100 >= 100 since last progress
  });

  it('is disabled when the limit is non-positive', () => {
    const tracker = new QuestProgressStallTracker(0);
    expect(tracker.update(10, 0)).toBe(false);
    expect(tracker.update(10, 1_000_000)).toBe(false);

    const negative = new QuestProgressStallTracker(-50);
    expect(negative.update(3, 0)).toBe(false);
    expect(negative.update(3, 1_000_000)).toBe(false);
  });

  it('reports frames since the last improvement', () => {
    const tracker = new QuestProgressStallTracker(100);
    expect(tracker.framesSinceProgress(50)).toBe(0); // before any update
    tracker.update(10, 10);
    expect(tracker.framesSinceProgress(60)).toBe(50);
    tracker.update(20, 70); // improvement
    expect(tracker.framesSinceProgress(100)).toBe(30);
  });

  it('is deterministic for identical input sequences', () => {
    const run = (): boolean[] => {
      const tracker = new QuestProgressStallTracker(100);
      const scores: Array<[number, number]> = [
        [10, 0],
        [10, 60],
        [15, 120],
        [15, 219],
        [15, 220],
      ];
      return scores.map(([s, f]) => tracker.update(s, f));
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual([false, false, false, false, true]);
  });
});

describe('formatQuestStallReason', () => {
  const DELTA_MS = 1000 / 60;

  it('names completed and stalled-on quests and reports elapsed seconds', () => {
    const quests = [
      makeQuest('floor1-find-welcome', 'complete'),
      makeQuest('floor1-tutorial', 'active'),
    ];
    const reason = formatQuestStallReason(quests, 9000, DELTA_MS);
    expect(reason).toContain('150s');
    expect(reason).toContain('completed: [floor1-find-welcome]');
    expect(reason).toContain('stalled on: [floor1-tutorial]');
  });

  it('uses placeholders when nothing is completed', () => {
    const reason = formatQuestStallReason([makeQuest('floor1-tutorial', 'active')], 6000, DELTA_MS);
    expect(reason).toContain('completed: [(none)]');
    expect(reason).toContain('stalled on: [floor1-tutorial]');
  });

  it('uses a placeholder when there is no active quest left', () => {
    const reason = formatQuestStallReason(
      [makeQuest('floor1-find-welcome', 'complete')],
      6000,
      DELTA_MS,
    );
    expect(reason).toContain('stalled on: [(no active quest)]');
  });
});
