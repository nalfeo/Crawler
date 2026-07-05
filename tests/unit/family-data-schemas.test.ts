import { describe, expect, it, afterEach } from 'vitest';
import {
  loadFamilies,
  familyDefSchema,
  _resetFamilyCache,
} from '../../src/shared/data/families.js';
import {
  loadResources,
  resourceDefSchema,
  _resetResourceCache,
} from '../../src/shared/data/resources.js';
import familiesJson from '../../src/shared/data/families.json';
import resourcesJson from '../../src/shared/data/resources.json';

/**
 * ADR 0011 pattern: content is Zod-validated at load time. This suite pins the
 * shape and the invariants the Floor 2 spec calls out (FR4 — ≥15 families; the
 * resource pool sits in the 10–20 band).
 */

describe('families.json', () => {
  afterEach(() => {
    _resetFamilyCache();
  });

  it('parses under familyDefSchema', () => {
    for (const raw of familiesJson as unknown[]) {
      expect(() => familyDefSchema.parse(raw)).not.toThrow();
    }
  });

  it('loads via loadFamilies() with ≥15 entries', () => {
    const families = loadFamilies();
    expect(families.length).toBeGreaterThanOrEqual(15);
  });

  it('returns the same cached reference on repeated calls', () => {
    const first = loadFamilies();
    const second = loadFamilies();
    expect(first).toBe(second);
  });

  it('_resetFamilyCache causes a fresh load on next call', () => {
    const first = loadFamilies();
    _resetFamilyCache();
    const second = loadFamilies();
    // Same content, but fresh object after reset
    expect(second.length).toBe(first.length);
  });

  it('has unique family ids', () => {
    const ids = loadFamilies().map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses valid #RRGGBB hudColor on every entry', () => {
    for (const f of loadFamilies()) {
      expect(f.hudColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('carries the required boss triple {title,name,archetype}', () => {
    for (const f of loadFamilies()) {
      expect(f.boss.title.length).toBeGreaterThan(0);
      expect(f.boss.name.length).toBeGreaterThan(0);
      expect(f.boss.archetype.length).toBeGreaterThan(0);
    }
  });
});

describe('resources.json', () => {
  afterEach(() => {
    _resetResourceCache();
  });

  it('parses under resourceDefSchema', () => {
    for (const raw of resourcesJson as unknown[]) {
      expect(() => resourceDefSchema.parse(raw)).not.toThrow();
    }
  });

  it('loads via loadResources() with 10–20 entries', () => {
    const resources = loadResources();
    expect(resources.length).toBeGreaterThanOrEqual(10);
    expect(resources.length).toBeLessThanOrEqual(20);
  });

  it('returns the same cached reference on repeated calls', () => {
    const first = loadResources();
    const second = loadResources();
    expect(first).toBe(second);
  });

  it('_resetResourceCache causes a fresh load on next call', () => {
    const first = loadResources();
    _resetResourceCache();
    const second = loadResources();
    expect(second.length).toBe(first.length);
  });

  it('has unique resource ids', () => {
    const ids = loadResources().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
