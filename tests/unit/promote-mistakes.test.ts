import { describe, expect, it } from 'vitest';
import {
  type Entity,
  type MemoryRecord,
  MAX_LINE_LEN,
  existingSlugs,
  extractSlugFromObservation,
  observationForSlug,
  parseMemory,
  serializeMemory,
  slugFromFile,
  summarizeMistakes,
  upsertEntity,
} from '../../scripts/agent/docs/promote-mistakes-lib.js';

describe('parseMemory', () => {
  it('parses newline-delimited JSON records and ignores blank lines', () => {
    const raw = '{"type":"entity","name":"A","entityType":"t","observations":[]}\n\n';
    const { records, malformedLines } = parseMemory(raw);
    expect(records).toHaveLength(1);
    expect(malformedLines).toEqual([]);
  });

  it('records (does not drop) malformed non-empty lines by 1-based index', () => {
    const raw = [
      '{"type":"entity","name":"A","entityType":"t","observations":[]}',
      'not json',
      '',
    ].join('\n');
    const { records, malformedLines } = parseMemory(raw);
    expect(records).toHaveLength(1);
    expect(malformedLines).toEqual([2]);
  });

  it('flags every malformed line so a rewrite can be refused', () => {
    const raw = ['oops', '{"type":"relation","from":"a","to":"b","relationType":"r"}', 'nope'].join(
      '\n',
    );
    const { records, malformedLines } = parseMemory(raw);
    expect(records).toHaveLength(1);
    expect(malformedLines).toEqual([1, 3]);
  });
});

describe('serializeMemory', () => {
  it('round-trips records back to JSONL with a trailing newline', () => {
    const records: MemoryRecord[] = [
      { type: 'entity', name: 'A', entityType: 't', observations: ['[x] y'] },
      { type: 'relation', from: 'A', to: 'B', relationType: 'r' },
    ];
    const text = serializeMemory(records);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseMemory(text).records).toEqual(records);
    expect(parseMemory(text).malformedLines).toEqual([]);
  });
});

describe('summarizeMistakes', () => {
  it('strips list markers, collapses whitespace, and joins with semicolons', () => {
    expect(summarizeMistakes(['- first  mistake', '* second\tmistake'])).toBe(
      'first mistake; second mistake',
    );
  });

  it('joins wrapped continuation lines with a space, not a semicolon', () => {
    // Simulates a Markdown bullet whose text soft-wraps over multiple lines.
    expect(
      summarizeMistakes([
        '- First item wraps',
        '  onto the next line.',
        '- Second item also',
        '  continues here.',
      ]),
    ).toBe('First item wraps onto the next line.; Second item also continues here.');
  });

  it('truncates overly long summaries on a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(200).trim();
    const out = summarizeMistakes([long]);
    expect(out.length).toBeLessThanOrEqual(MAX_LINE_LEN);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('slug helpers', () => {
  it('derives a slug from a handoff filename', () => {
    expect(slugFromFile('2026-07-03-my-session.md')).toBe('2026-07-03-my-session');
  });

  it('round-trips slug ↔ observation', () => {
    const obs = observationForSlug('2026-07-03-x', 'did a thing');
    expect(obs).toBe('[2026-07-03-x] did a thing');
    expect(extractSlugFromObservation(obs)).toBe('2026-07-03-x');
  });

  it('returns null for an observation without a slug prefix', () => {
    expect(extractSlugFromObservation('no slug here')).toBeNull();
  });

  it('collects the set of already-recorded slugs (idempotency key)', () => {
    const entity: Entity = {
      type: 'entity',
      name: 'Session_Mistakes',
      entityType: 'lessons',
      observations: ['[2026-01-01-a] x', '[2026-01-02-b] y', 'legacy note without slug'],
    };
    const slugs = existingSlugs(entity);
    expect([...slugs].sort()).toEqual(['2026-01-01-a', '2026-01-02-b']);
  });
});

describe('upsertEntity', () => {
  it('replaces an existing entity in place', () => {
    const records: MemoryRecord[] = [
      { type: 'entity', name: 'Session_Mistakes', entityType: 'lessons', observations: ['old'] },
      { type: 'relation', from: 'a', to: 'b', relationType: 'r' },
    ];
    const updated: Entity = {
      type: 'entity',
      name: 'Session_Mistakes',
      entityType: 'lessons',
      observations: ['old', 'new'],
    };
    const next = upsertEntity(records, updated);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(updated);
    expect(next[1]).toBe(records[1]);
  });

  it('inserts a new entity after the last existing entity, ahead of relations', () => {
    const records: MemoryRecord[] = [
      { type: 'entity', name: 'Other', entityType: 't', observations: [] },
      { type: 'relation', from: 'a', to: 'b', relationType: 'r' },
    ];
    const fresh: Entity = {
      type: 'entity',
      name: 'Session_Mistakes',
      entityType: 'lessons',
      observations: ['first'],
    };
    const next = upsertEntity(records, fresh);
    expect(next.map((r) => r.type)).toEqual(['entity', 'entity', 'relation']);
    expect(next[1]).toBe(fresh);
  });

  it('collapses duplicate entities: only the first match is replaced, extras are dropped', () => {
    const dup: Entity = {
      type: 'entity',
      name: 'Session_Mistakes',
      entityType: 'lessons',
      observations: ['old'],
    };
    const records: MemoryRecord[] = [
      dup,
      { ...dup }, // second copy — simulates a corrupted JSONL
      { type: 'relation', from: 'a', to: 'b', relationType: 'r' },
    ];
    const updated: Entity = { ...dup, observations: ['old', 'new'] };
    const next = upsertEntity(records, updated);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(updated);
    expect(next[1]).toBe(records[2]);
  });

  it('is idempotent: re-upserting the same entity yields an equivalent layout', () => {
    const base: MemoryRecord[] = [
      { type: 'entity', name: 'Other', entityType: 't', observations: [] },
    ];
    const entity: Entity = {
      type: 'entity',
      name: 'Session_Mistakes',
      entityType: 'lessons',
      observations: ['[2026-01-01-a] x'],
    };
    const once = upsertEntity(base, entity);
    const twice = upsertEntity(once, entity);
    expect(serializeMemory(twice)).toBe(serializeMemory(once));
  });
});
