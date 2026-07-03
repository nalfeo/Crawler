/**
 * Slice 6 · Unit tests for the emergent-event pack Zod schema + loader.
 */
import { describe, expect, it } from 'vitest';
import {
  emergentEventPackSchema,
  loadEmergentEventPack,
  _resetEmergentEventCache,
} from '../../src/shared/data/emergent-events.js';
import eventsJson from '../../src/shared/data/quests.floor2.events.json';
import tuning from '../../src/shared/data/tuning.json';

describe('quests.floor2.events.json schema', () => {
  it('parses cleanly under Zod', () => {
    expect(() => emergentEventPackSchema.parse(eventsJson)).not.toThrow();
  });

  it('exposes 6 authored events (spec §Emergent events)', () => {
    _resetEmergentEventCache();
    const pack = loadEmergentEventPack();
    expect(pack.events).toHaveLength(6);
  });

  it('every event id is unique', () => {
    _resetEmergentEventCache();
    const pack = loadEmergentEventPack();
    const ids = pack.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every deltaKey resolves against tuning.factionRelations.deltas', () => {
    _resetEmergentEventCache();
    const pack = loadEmergentEventPack();
    const deltas = tuning.factionRelations.deltas as Record<string, number>;
    for (const event of pack.events) {
      for (const effect of event.effects) {
        expect(effect.deltaKey in deltas).toBe(true);
      }
    }
  });

  it('every event has a static narration line (P6 — no runtime LLM)', () => {
    _resetEmergentEventCache();
    const pack = loadEmergentEventPack();
    for (const event of pack.events) {
      expect(event.narration.length).toBeGreaterThan(0);
    }
  });

  it('trigger types cover timer + regionEnter + threshold (all three levers)', () => {
    _resetEmergentEventCache();
    const pack = loadEmergentEventPack();
    const kinds = new Set(pack.events.map((e) => e.trigger.type));
    expect(kinds).toContain('timer');
    expect(kinds).toContain('regionEnter');
    expect(kinds).toContain('threshold');
  });
});
