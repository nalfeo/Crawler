import { describe, expect, it } from 'vitest';

import {
  loadPersonaRouting,
  parsePersonaRouting,
  systemsByPersona,
} from '../../../scripts/agent/shared/persona-routing.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'persona-routing/v1',
    unrouted_persona: 'Producer',
    personas: [
      { name: 'Producer', file: 'producer.md', agent: 'producer.agent.md', systems: [] },
      {
        name: 'Game Designer',
        file: 'game-designer.md',
        agent: 'game-designer.agent.md',
        systems: ['game', 'combat'],
      },
    ],
    siblings: [],
    ...overrides,
  };
}

describe('persona routing manifest', () => {
  const routing = loadPersonaRouting();

  it('loads and validates the committed manifest', () => {
    expect(routing.schema_version).toBe('persona-routing/v1');
    expect(routing.personas.length).toBeGreaterThan(0);
  });

  it('names a triage persona that is itself a listed persona', () => {
    expect(routing.personas.map((p) => p.name)).toContain(routing.unrouted_persona);
  });

  it('gives every persona a persona doc filename and an agent filename', () => {
    for (const persona of routing.personas) {
      expect(persona.file).toMatch(/^[a-z0-9-]+\.md$/);
      expect(persona.agent).toMatch(/^[a-z0-9-]+\.agent\.md$/);
    }
  });

  it('never lets two personas claim the same system keyword', () => {
    const seen = new Set<string>();
    for (const persona of routing.personas) {
      for (const system of persona.systems) {
        expect(seen.has(system)).toBe(false);
        seen.add(system);
      }
    }
  });

  it('routes the generic `game` bucket and the `core` layer', () => {
    const mapping = systemsByPersona(routing);
    expect(mapping['Game Designer']).toContain('game');
    expect(mapping['Systems Engineer']).toContain('core');
  });

  it('omits personas that own no system keywords from the decomposition mapping', () => {
    const mapping = systemsByPersona(routing);
    for (const persona of routing.personas) {
      if (persona.systems.length === 0) expect(mapping[persona.name]).toBeUndefined();
      else expect(mapping[persona.name]).toEqual(persona.systems);
    }
  });

  it('points every specialist sibling at a persona listed in the manifest', () => {
    const personaFiles = new Set(routing.personas.map((p) => p.file));
    for (const sibling of routing.siblings) {
      expect(personaFiles.has(sibling.inherits)).toBe(true);
    }
  });
});

describe('parsePersonaRouting validation', () => {
  it('accepts a well-formed manifest', () => {
    expect(parsePersonaRouting(manifest()).personas).toHaveLength(2);
  });

  it('rejects an unsupported schema version', () => {
    expect(() => parsePersonaRouting(manifest({ schema_version: 'v2' }))).toThrow(/schema_version/);
  });

  it('rejects a triage persona that is not itself listed', () => {
    expect(() => parsePersonaRouting(manifest({ unrouted_persona: 'Nobody' }))).toThrow(
      /not a listed persona/,
    );
  });

  it('rejects two personas claiming the same system keyword', () => {
    const bad = manifest();
    (bad.personas as Array<Record<string, unknown>>)[0]!.systems = ['combat'];
    expect(() => parsePersonaRouting(bad)).toThrow(/claimed by both/);
  });

  // A duplicate name would silently overwrite the earlier entry once the
  // manifest is keyed by persona name, dropping every system it owned.
  it.each(['name', 'file', 'agent'])('rejects a duplicate persona %s', (field) => {
    const bad = manifest();
    const personas = bad.personas as Array<Record<string, unknown>>;
    personas[1]![field] = personas[0]![field];
    expect(() => parsePersonaRouting(bad)).toThrow(new RegExp(`duplicate persona ${field}`));
  });

  it('rejects a duplicate sibling agent', () => {
    const bad = manifest({
      siblings: [
        { agent: 'perf-optimizer.agent.md', inherits: 'producer.md' },
        { agent: 'perf-optimizer.agent.md', inherits: 'game-designer.md' },
      ],
    });
    expect(() => parsePersonaRouting(bad)).toThrow(/duplicate sibling agent/);
  });

  it('rejects an agent listed as both a canonical agent and a sibling', () => {
    const bad = manifest({
      siblings: [{ agent: 'producer.agent.md', inherits: 'game-designer.md' }],
    });
    expect(() => parsePersonaRouting(bad)).toThrow(/both as a canonical agent and a sibling/);
  });

  it('rejects malformed shapes rather than dropping entries', () => {
    expect(() => parsePersonaRouting(manifest({ personas: [] }))).toThrow(/non-empty array/);
    expect(() => parsePersonaRouting(manifest({ siblings: 'nope' }))).toThrow(/must be an array/);
    expect(() => parsePersonaRouting(manifest({ personas: [{ name: 'X' }] }))).toThrow(
      /personas\[0\]\.file/,
    );
    expect(() => parsePersonaRouting(null)).toThrow(/JSON object/);
  });
});
