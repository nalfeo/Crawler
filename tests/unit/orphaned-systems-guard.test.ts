import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST,
  REQUIRED_ALLOWLIST_FIELDS,
  SYSTEM_SOURCE_ROOTS,
  WIRING_SITES,
  collectExportedSystems,
  collectWiredRefs,
  extractReferencedSystems,
  extractSystemDefs,
  findMalformedAllowlistEntries,
  findOrphanedSystems,
  findStaleAllowlistEntries,
  type AllowlistEntry,
  type SourceFile,
} from '../../scripts/agent/health/orphaned-systems-lib.js';

/**
 * Regression coverage for the "orphaned ECS system" wiring guard (ADR 0039).
 *
 * The guard exists because `spawnerSystem` shipped fully inert: it was only ever
 * force-called by `src/labs/spawner-lab/index.ts`, never by a real pipeline. A
 * lab force-call proves the system works in isolation but can NEVER prove the
 * real game calls it.
 *
 * These tests pin the AST-based detection logic. An earlier regex/text draft
 * was proven unsafe by two separate-model reviews: a string literal counted as a
 * real reference, a URL truncated a genuine reference, and re-exports were
 * invisible. The cases below lock in that the AST implementation rejects those
 * false signals and detects the export forms the regex draft missed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkTs(absDir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(absDir, e);
    if (statSync(abs).isDirectory()) out.push(...walkTs(abs));
    else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

function loadRealSystems() {
  const files: SourceFile[] = [];
  for (const root of SYSTEM_SOURCE_ROOTS) {
    for (const abs of walkTs(path.join(repoRoot, root))) {
      files.push({
        path: path.relative(repoRoot, abs).replace(/\\/g, '/'),
        content: readFileSync(abs, 'utf8'),
      });
    }
  }
  return collectExportedSystems(files);
}

function loadRealWiredRefs(): Set<string> {
  const wiringFiles: SourceFile[] = WIRING_SITES.map((rel) => ({
    path: rel,
    content: readFileSync(path.join(repoRoot, rel), 'utf8'),
  }));
  return collectWiredRefs(wiringFiles);
}

describe('extractSystemDefs', () => {
  it('finds function and const *System exports, ignoring types and non-exports', () => {
    const file: SourceFile = {
      path: 'src/game/x.ts',
      content: [
        'export function spawnerSystem(world: GameWorld): void {}',
        'export const movementSystem = (world: GameWorld) => {};',
        'export async function beamSystem(world: GameWorld) {}',
        'export interface DropSystemOptions {}',
        'export type SpawnerConfig = {};',
        'function privateHelperSystem() {}', // not exported → ignored
        'const localOnlySystem = () => {};', // not exported → ignored
      ].join('\n'),
    };
    const names = extractSystemDefs(file)
      .map((d) => d.name)
      .sort();
    expect(names).toEqual(['beamSystem', 'movementSystem', 'spawnerSystem']);
  });

  it('detects re-export forms the regex draft missed (export { ... } and rename)', () => {
    const file: SourceFile = {
      path: 'src/game/index.ts',
      content: [
        "export { fooSystem } from './foo.js';",
        "import { internalImpl } from './bar.js';",
        'export { internalImpl as barSystem };',
        "export { helperUtil } from './baz.js';",
      ].join('\n'),
    };
    const defs = extractSystemDefs(file);
    const names = defs.map((d) => d.name).sort();
    // `internalImpl as barSystem` exposes the OUTWARD name `barSystem`.
    expect(names).toEqual(['barSystem', 'fooSystem']);
    // Re-exports are marked as such so a barrel does not shadow the real def.
    expect(defs.every((d) => d.kind === 'reexport')).toBe(true);
  });
});

describe('collectExportedSystems', () => {
  it('prefers the concrete declaration file over a re-export barrel', () => {
    const files: SourceFile[] = [
      // Barrel sorts before the impl path, but must NOT win attribution.
      {
        path: 'src/game/index.ts',
        content: "export { spawnerSystem } from './spawners/spawnerSystem.js';",
      },
      {
        path: 'src/game/spawners/spawnerSystem.ts',
        content: 'export function spawnerSystem(world) {}',
      },
    ];
    const defs = collectExportedSystems(files);
    const spawner = defs.find((d) => d.name === 'spawnerSystem');
    expect(spawner?.file).toBe('src/game/spawners/spawnerSystem.ts');
    expect(spawner?.kind).toBe('declaration');
  });

  it('ignores .test.ts / .spec.ts files', () => {
    const files: SourceFile[] = [
      { path: 'src/game/fooSystem.ts', content: 'export function fooSystem(w) {}' },
      { path: 'src/game/fooSystem.test.ts', content: 'export function barSystem(w) {}' },
    ];
    expect(collectExportedSystems(files).map((d) => d.name)).toEqual(['fooSystem']);
  });
});

describe('extractReferencedSystems (AST)', () => {
  it('does not count a system named only inside a comment', () => {
    const file: SourceFile = {
      path: 'src/engine/sim/simulation-step.ts',
      content: [
        '// spawnerSystem should run here but we forgot to call it',
        '/* another mention of spawnerSystem in a block comment */',
        'movementSystem(world);',
      ].join('\n'),
    };
    const refs = extractReferencedSystems(file);
    expect(refs.has('movementSystem')).toBe(true);
    expect(refs.has('spawnerSystem')).toBe(false);
  });

  it('does not count a system named only inside a string literal', () => {
    // The exact false-positive the regex draft produced.
    const file: SourceFile = {
      path: 'src/engine/sim/simulation-step.ts',
      content: ['const note = "spawnerSystem";', 'movementSystem(world);'].join('\n'),
    };
    const refs = extractReferencedSystems(file);
    expect(refs.has('spawnerSystem')).toBe(false);
    expect(refs.has('movementSystem')).toBe(true);
  });

  it('does not count a system named inside a URL string', () => {
    // The regex draft truncated this when stripping `//`, hiding a real miss.
    const file: SourceFile = {
      path: 'src/engine/sim/simulation-step.ts',
      content: 'const doc = "http://example.com/spawnerSystem";',
    };
    expect(extractReferencedSystems(file).has('spawnerSystem')).toBe(false);
  });

  it('does not count import specifiers or type positions as wiring', () => {
    const file: SourceFile = {
      path: 'src/engine/sim/simulation-step.ts',
      content: [
        "import { spawnerSystem } from '../../game/spawners/spawnerSystem.js';",
        'let fn: typeof spawnerSystem;',
      ].join('\n'),
    };
    // Imported + referenced only in a type position → NOT wired.
    expect(extractReferencedSystems(file).has('spawnerSystem')).toBe(false);
  });

  it('counts a direct call expression', () => {
    const file: SourceFile = {
      path: 'src/game/ai/simulation-step.ts',
      content: 'spawnerSystem(world);',
    };
    expect(extractReferencedSystems(file).has('spawnerSystem')).toBe(true);
  });

  it('counts systems referenced as bare identifiers in a pipeline array', () => {
    const file: SourceFile = {
      path: 'src/bootstrap/floor-main-scene-options.ts',
      content: 'const preSystems = [enemyAISystem, spawnerSystem, floor1EnemyDirectorSystem];',
    };
    expect([...extractReferencedSystems(file)].sort()).toEqual([
      'enemyAISystem',
      'floor1EnemyDirectorSystem',
      'spawnerSystem',
    ]);
  });

  it('counts spread identifiers in a pipeline array', () => {
    const file: SourceFile = {
      path: 'src/bootstrap/floor-main-scene-options.ts',
      content: 'const all = [...coreSystems, spawnerSystem];',
    };
    expect(extractReferencedSystems(file).has('spawnerSystem')).toBe(true);
  });
});

describe('findOrphanedSystems', () => {
  const systems = [
    {
      name: 'spawnerSystem',
      file: 'src/game/spawners/spawnerSystem.ts',
      kind: 'declaration' as const,
    },
    {
      name: 'movementSystem',
      file: 'src/core/systems/movementSystem.ts',
      kind: 'declaration' as const,
    },
    {
      name: 'enemySpawnerSystem',
      file: 'src/game/enemySpawnerSystem.ts',
      kind: 'declaration' as const,
    },
  ];
  const entry: AllowlistEntry = {
    reason: 'lab/test-only helper',
    trackedIssue: 'ADR 0039',
    owner: 'labs',
  };
  const allowlist = { enemySpawnerSystem: entry };

  it('FLAGS an unwired, non-allowlisted system (models the pre-#665 spawner bug)', () => {
    const wiredRefs = new Set(['movementSystem']); // spawnerSystem NOT wired
    const orphans = findOrphanedSystems({ systems, wiredRefs, allowlist });
    expect(orphans.map((o) => o.name)).toEqual(['spawnerSystem']);
  });

  it('PASSES once the system is wired into a real pipeline (models the #665 fix)', () => {
    const wiredRefs = new Set(['movementSystem', 'spawnerSystem']);
    const orphans = findOrphanedSystems({ systems, wiredRefs, allowlist });
    expect(orphans).toEqual([]);
  });

  it('does not flag an allowlisted system even when unwired', () => {
    const wiredRefs = new Set(['movementSystem', 'spawnerSystem']);
    const orphans = findOrphanedSystems({ systems, wiredRefs, allowlist });
    expect(orphans.map((o) => o.name)).not.toContain('enemySpawnerSystem');
  });

  it('a lab-only reference does NOT satisfy wiring (labs are excluded by design)', () => {
    const wiredRefs = new Set<string>(); // no wiring site references spawnerSystem
    const orphans = findOrphanedSystems({ systems: [systems[0]!], wiredRefs, allowlist });
    expect(orphans.map((o) => o.name)).toEqual(['spawnerSystem']);
  });
});

describe('findMalformedAllowlistEntries', () => {
  it('flags entries missing required fields (blank counts as missing)', () => {
    const allowlist: Record<string, AllowlistEntry> = {
      good: { reason: 'x', trackedIssue: '#1', owner: 'me' },
      // @ts-expect-error deliberately missing owner for the test
      noOwner: { reason: 'x', trackedIssue: '#1' },
      blankReason: { reason: '   ', trackedIssue: '#1', owner: 'me' },
    };
    const bad = findMalformedAllowlistEntries(allowlist);
    expect(bad.map((b) => b.name)).toEqual(['blankReason', 'noOwner']);
    expect(bad.find((b) => b.name === 'noOwner')?.missing).toContain('owner');
    expect(bad.find((b) => b.name === 'blankReason')?.missing).toContain('reason');
  });
});

describe('findStaleAllowlistEntries', () => {
  const systems = [
    {
      name: 'spawnerSystem',
      file: 'src/game/spawners/spawnerSystem.ts',
      kind: 'declaration' as const,
    },
    {
      name: 'enemySpawnerSystem',
      file: 'src/game/enemySpawnerSystem.ts',
      kind: 'declaration' as const,
    },
  ];
  const entry: AllowlistEntry = { reason: 'r', trackedIssue: '#1', owner: 'o' };

  it('flags a "missing" entry when the system no longer exists', () => {
    const allowlist = { goneSystem: entry };
    const stale = findStaleAllowlistEntries(systems, new Set(), allowlist);
    expect(stale).toEqual([{ name: 'goneSystem', kind: 'missing' }]);
  });

  it('flags a "redundant" entry when the allowlisted system is now wired', () => {
    const allowlist = { spawnerSystem: entry };
    const stale = findStaleAllowlistEntries(systems, new Set(['spawnerSystem']), allowlist);
    expect(stale).toEqual([{ name: 'spawnerSystem', kind: 'redundant' }]);
  });

  it('does not flag a genuinely-unwired, existing allowlisted system', () => {
    const allowlist = { enemySpawnerSystem: entry };
    expect(findStaleAllowlistEntries(systems, new Set(), allowlist)).toEqual([]);
  });
});

describe('ALLOWLIST honesty invariants (against the real source tree)', () => {
  const realSystems = loadRealSystems();
  const realWiredRefs = loadRealWiredRefs();

  it('every allowlist entry carries all required fields', () => {
    expect(findMalformedAllowlistEntries(ALLOWLIST)).toEqual([]);
    // Belt-and-braces: assert each required key is a non-empty string.
    for (const [name, e] of Object.entries(ALLOWLIST)) {
      for (const field of REQUIRED_ALLOWLIST_FIELDS) {
        const value = e[field];
        expect(
          typeof value === 'string' && value.trim().length > 0,
          `ALLOWLIST["${name}"].${field} must be a non-empty string`,
        ).toBe(true);
      }
    }
  });

  it('no allowlist entry is stale (system gone) or redundant (now wired)', () => {
    expect(findStaleAllowlistEntries(realSystems, realWiredRefs, ALLOWLIST)).toEqual([]);
  });

  it('the real tree exports the systems the guard is meant to check', () => {
    const names = realSystems.map((s) => s.name);
    expect(names).toContain('movementSystem');
    expect(names).toContain('spawnerSystem');
    expect(realSystems.length).toBeGreaterThan(20);
  });
});
