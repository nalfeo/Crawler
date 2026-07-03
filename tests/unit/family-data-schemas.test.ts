import { describe, expect, it } from 'vitest';
import { loadFamilies, familyDefSchema } from '../../src/shared/data/families.js';
import { loadResources, resourceDefSchema } from '../../src/shared/data/resources.js';
import familiesJson from '../../src/shared/data/families.json';
import resourcesJson from '../../src/shared/data/resources.json';

/**
 * ADR 0011 pattern: content is Zod-validated at load time. This suite pins the
 * shape and the invariants the Floor 2 spec calls out (FR4 — ≥15 families; the
 * resource pool sits in the 10–20 band).
 */

describe('families.json', () => {
  it('parses under familyDefSchema', () => {
    for (const raw of familiesJson as unknown[]) {
      expect(() => familyDefSchema.parse(raw)).not.toThrow();
    }
  });

  it('loads via loadFamilies() with ≥15 entries', () => {
    const families = loadFamilies();
    expect(families.length).toBeGreaterThanOrEqual(15);
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

  it('has unique resource ids', () => {
    const ids = loadResources().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
