import { describe, it, expect } from 'vitest';
import { pickChosen, type RunSummaryEntry } from '../../../scripts/sprites/run-artifacts.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  const base: Brief = {
    name: 'test',
    type: 'weapon',
    prompt: 'a test sprite',
    cellPx: 16,
    grid: { cols: 4, rows: 4 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 14 },
    references: [],
    sensors: {},
  } as unknown as Brief;
  return { ...base, ...overrides };
}

function makeEntry(overrides: Partial<RunSummaryEntry> = {}): RunSummaryEntry {
  return {
    index: 0,
    score: 7,
    outOf: 7,
    passed: true,
    rawPath: '/tmp/raw/00.png',
    processedPath: '/tmp/processed/00.png',
    scorecardPath: '/tmp/processed/00.scorecard.json',
    derivedAnchor: null,
    anchorSidecarPath: null,
    ...overrides,
  };
}

describe('pickChosen', () => {
  it('returns null when no candidates are ranked', () => {
    expect(pickChosen([], makeBrief())).toBeNull();
  });

  it('surfaces the brief anchor with source=brief in legacy mode', () => {
    const brief = makeBrief({ anchor: { x: 8, y: 14 } });
    const result = pickChosen([makeEntry()], brief);
    expect(result?.anchor).toEqual({ x: 8, y: 14, source: 'brief' });
  });

  it('surfaces the derivedAnchor with source=derived in derive mode when available', () => {
    const brief = makeBrief({
      sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } },
    } as Partial<Brief>);
    const result = pickChosen([makeEntry({ derivedAnchor: { x: 7, y: 15 } })], brief);
    expect(result?.anchor).toEqual({ x: 7, y: 15, source: 'derived' });
  });

  it('returns anchor=null in derive mode when derivation failed (never falls back to brief)', () => {
    const brief = makeBrief({
      anchor: { x: 8, y: 14 },
      sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } },
    } as Partial<Brief>);
    const result = pickChosen([makeEntry({ derivedAnchor: null })], brief);
    expect(result?.anchor).toBeNull();
  });

  it('prefers derivedAnchor over brief anchor when both are available', () => {
    // Belt-and-suspenders: if derive somehow ran but the brief still has
    // anchor, the derived value wins. Source must reflect provenance.
    const brief = makeBrief({ anchor: { x: 8, y: 14 } });
    const result = pickChosen([makeEntry({ derivedAnchor: { x: 5, y: 13 } })], brief);
    expect(result?.anchor).toEqual({ x: 5, y: 13, source: 'derived' });
  });

  it('respects the ranked order: returns the top candidate, not necessarily index 0', () => {
    const top = makeEntry({ index: 3, score: 7, derivedAnchor: { x: 7, y: 14 } });
    const next = makeEntry({ index: 0, score: 6 });
    const brief = makeBrief({
      sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } },
    } as Partial<Brief>);
    const result = pickChosen([top, next], brief);
    expect(result?.index).toBe(3);
    expect(result?.anchor).toEqual({ x: 7, y: 14, source: 'derived' });
  });
});
