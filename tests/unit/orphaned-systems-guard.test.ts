import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST,
  MIN_EXPECTED_SYSTEMS,
  REQUIRED_ALLOWLIST_FIELDS,
  SYSTEM_SOURCE_ROOTS,
  WIRING_SITES,
  collectOpenRequiredTrackedIssues,
  collectExportedSystems,
  collectWiredRefs,
  extractReferencedSystems,
  extractSystemDefs,
  findClosedTrackedIssueEntries,
  findInvalidAllowlistPolicyEntries,
  findDuplicateSystemDeclarations,
  findMalformedAllowlistEntries,
  findOrphanedSystems,
  findStaleAllowlistEntries,
  parseTrackedIssueNumber,
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

  it('detects export-default / export-= assignment forms as declarations (dangerous false-clean)', () => {
    // A system shipped via `export default fooSystem` would otherwise be
    // invisible to discovery — never enumerated, so an orphan could merge green.
    // When the identifier names a LOCAL declaration, the file IS the
    // implementation, so it must be classified `declaration` (not `reexport`) —
    // otherwise duplicate detection and barrel attribution both break.
    const def: SourceFile = {
      path: 'src/game/foo.ts',
      content: ['const fooSystem = (world) => {};', 'export default fooSystem;'].join('\n'),
    };
    const defDefs = extractSystemDefs(def);
    expect(defDefs.map((d) => d.name)).toEqual(['fooSystem']);
    expect(defDefs[0]!.kind).toBe('declaration');

    const eq: SourceFile = {
      path: 'src/game/bar.ts',
      content: ['const barSystem = (world) => {};', 'export = barSystem;'].join('\n'),
    };
    const eqDefs = extractSystemDefs(eq);
    expect(eqDefs.map((d) => d.name)).toEqual(['barSystem']);
    expect(eqDefs[0]!.kind).toBe('declaration');
  });

  it('records export-default of a FORWARDED (imported) symbol as a re-export', () => {
    // No local declaration behind the assignment → it forwards an imported
    // symbol, so it is a genuine re-export, not this file's implementation.
    const file: SourceFile = {
      path: 'src/game/barrel.ts',
      content: ["import { fooSystem } from './foo.js';", 'export default fooSystem;'].join('\n'),
    };
    const defs = extractSystemDefs(file);
    expect(defs.map((d) => d.name)).toEqual(['fooSystem']);
    expect(defs[0]!.kind).toBe('reexport');
  });

  it('detects a named default-exported function (export default function fooSystem)', () => {
    const file: SourceFile = {
      path: 'src/game/foo.ts',
      content: 'export default function fooSystem(world) {}',
    };
    const defs = extractSystemDefs(file);
    expect(defs.map((d) => d.name)).toEqual(['fooSystem']);
    expect(defs[0]!.kind).toBe('declaration');
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

  it('counts an invoked *System nullish fallback callee', () => {
    const file: SourceFile = {
      path: 'src/core/simulation-core-step.ts',
      content: '(options.runFovSystem ?? fovSystem)(world);',
    };
    expect([...extractReferencedSystems(file)]).toEqual(['fovSystem']);
  });

  it('does not count nullish fallbacks used as values or arguments', () => {
    const file: SourceFile = {
      path: 'src/engine/sim/simulation-step.ts',
      content: [
        'const hooks = { runFovSystem: options.runFovSystem ?? fovSystem };',
        'helper(options.runFovSystem ?? fovSystem);',
      ].join('\n'),
    };
    expect(extractReferencedSystems(file).has('fovSystem')).toBe(false);
    expect(extractReferencedSystems(file).has('runFovSystem')).toBe(false);
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

  it('DOCUMENTED LIMITATION: an incidental reference in a wiring file counts as wired', () => {
    // The wiring sites are a tiny, curated, trusted set; distinguishing a live
    // pipeline array from a dead one would need whole-program dataflow. This
    // pins the accepted trusted-oracle behavior as a conscious contract: a dead
    // reference inside a wiring file DOES mark the system wired. (It is a
    // distinct, review-catchable smell, and far narrower than the lab-only bug
    // this guard targets.) If this ever changes, update the doc block + ADR.
    const deadArray: SourceFile = {
      path: 'src/engine/scenes/MainGameScene.ts',
      content: 'const unused = [spawnerSystem];',
    };
    expect(extractReferencedSystems(deadArray).has('spawnerSystem')).toBe(true);
    const deadCall: SourceFile = {
      path: 'src/engine/scenes/MainGameScene.ts',
      content: 'function debug(world) { spawnerSystem(world); }',
    };
    expect(extractReferencedSystems(deadCall).has('spawnerSystem')).toBe(true);
  });
});

describe('findDuplicateSystemDeclarations', () => {
  it('flags a *System name declared in two files (name-based-wiring false-clean)', () => {
    const files: SourceFile[] = [
      { path: 'src/game/a/fooSystem.ts', content: 'export function fooSystem(w) {}' },
      { path: 'src/game/b/fooSystem.ts', content: 'export const fooSystem = (w) => {};' },
    ];
    const dups = findDuplicateSystemDeclarations(files);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.name).toBe('fooSystem');
    expect(dups[0]!.files).toEqual(['src/game/a/fooSystem.ts', 'src/game/b/fooSystem.ts']);
  });

  it('does NOT flag a declaration plus its re-export barrel', () => {
    const files: SourceFile[] = [
      {
        path: 'src/game/spawners/spawnerSystem.ts',
        content: 'export function spawnerSystem(w) {}',
      },
      {
        path: 'src/game/index.ts',
        content: "export { spawnerSystem } from './spawners/spawnerSystem.js';",
      },
    ];
    expect(findDuplicateSystemDeclarations(files)).toEqual([]);
  });

  it('ignores duplicate names across .test.ts files', () => {
    const files: SourceFile[] = [
      { path: 'src/game/fooSystem.ts', content: 'export function fooSystem(w) {}' },
      { path: 'src/game/fooSystem.test.ts', content: 'export function fooSystem(w) {}' },
    ];
    expect(findDuplicateSystemDeclarations(files)).toEqual([]);
  });

  it('flags two default-exported systems with the same name (export-assignment false-clean)', () => {
    // Regression for the round-2 Blocking finding: `export default fooSystem`
    // behind a local decl must be a `declaration`, so two such files collide and
    // the duplicate guard catches the ambiguity (one could be wired, one orphan).
    const files: SourceFile[] = [
      {
        path: 'src/game/a/foo.ts',
        content: ['const fooSystem = (w) => {};', 'export default fooSystem;'].join('\n'),
      },
      {
        path: 'src/game/b/foo.ts',
        content: ['const fooSystem = (w) => {};', 'export default fooSystem;'].join('\n'),
      },
    ];
    const dups = findDuplicateSystemDeclarations(files);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.name).toBe('fooSystem');
  });

  it('the real source tree has no duplicate *System declarations', () => {
    const files: SourceFile[] = [];
    for (const root of SYSTEM_SOURCE_ROOTS) {
      for (const abs of walkTs(path.join(repoRoot, root))) {
        files.push({
          path: path.relative(repoRoot, abs).replace(/\\/g, '/'),
          content: readFileSync(abs, 'utf8'),
        });
      }
    }
    expect(findDuplicateSystemDeclarations(files)).toEqual([]);
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
    trackedIssuePolicy: 'reference-only',
    owner: 'labs',
  };
  const allowlist = { enemySpawnerSystem: entry };

  it('FLAGS an unwired, non-allowlisted system (models the pre-#665 spawner bug)', () => {
    const wiredRefs = new Set(['movementSystem']); // spawnerSystem NOT wired
    const orphans = findOrphanedSystems({ systems, wiredRefs, allowlist });
    expect(orphans.map((o) => o.name)).toEqual(['spawnerSystem']);
  });

  describe('sim-side/shared wiring witness contract', () => {
    const system = {
      name: 'sceneOnlySystem',
      file: 'src/game/sceneOnlySystem.ts',
      kind: 'declaration' as const,
    };

    function refsFromTrustedSites(files: SourceFile[]): Set<string> {
      return collectWiredRefs(files.filter((file) => WIRING_SITES.includes(file.path)));
    }

    it('excludes MainGameScene and includes the shared core + both sim steps', () => {
      expect(WIRING_SITES).toEqual([
        'src/bootstrap/floor-main-scene-options.ts',
        'src/core/simulation-core-step.ts',
        'src/engine/sim/simulation-step.ts',
        'src/game/ai/simulation-step.ts',
        'src/game/ai/headless-runner.ts',
      ]);
      expect(WIRING_SITES).not.toContain('src/engine/scenes/MainGameScene.ts');
    });

    it('FAILS a system referenced only by the visual scene', () => {
      const wiredRefs = refsFromTrustedSites([
        {
          path: 'src/engine/scenes/MainGameScene.ts',
          content: 'sceneOnlySystem(world);',
        },
      ]);
      expect(findOrphanedSystems({ systems: [system], wiredRefs })).toEqual([
        { name: 'sceneOnlySystem', file: 'src/game/sceneOnlySystem.ts' },
      ]);
    });

    it('PASSES a system wired through the shared bootstrap options', () => {
      const wiredRefs = refsFromTrustedSites([
        {
          path: 'src/bootstrap/floor-main-scene-options.ts',
          content: 'const preSystems = [sceneOnlySystem];',
        },
      ]);
      expect(findOrphanedSystems({ systems: [system], wiredRefs })).toEqual([]);
    });

    it.each(['src/engine/sim/simulation-step.ts', 'src/game/ai/simulation-step.ts'])(
      'PASSES a system wired through %s',
      (site) => {
        const wiredRefs = refsFromTrustedSites([
          { path: site, content: 'sceneOnlySystem(world);' },
        ]);
        expect(findOrphanedSystems({ systems: [system], wiredRefs })).toEqual([]);
      },
    );

    it('PASSES an allowlisted system without a sim-side reference', () => {
      const allowlist = {
        sceneOnlySystem: {
          reason: 'intentionally not wired',
          trackedIssue: '#1',
          trackedIssuePolicy: 'reference-only' as const,
          owner: 'tests',
        },
      };
      expect(findOrphanedSystems({ systems: [system], wiredRefs: new Set(), allowlist })).toEqual(
        [],
      );
    });
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
      good: {
        reason: 'x',
        trackedIssue: '#1',
        trackedIssuePolicy: 'reference-only',
        owner: 'me',
      },
      // @ts-expect-error deliberately missing owner for the test
      noOwner: { reason: 'x', trackedIssue: '#1', trackedIssuePolicy: 'reference-only' },
      // @ts-expect-error deliberately missing trackedIssuePolicy for the test
      noPolicy: { reason: 'x', trackedIssue: '#1', owner: 'me' },
      blankReason: {
        reason: '   ',
        trackedIssue: '#1',
        trackedIssuePolicy: 'reference-only',
        owner: 'me',
      },
    };
    const bad = findMalformedAllowlistEntries(allowlist);
    expect(bad.map((b) => b.name)).toEqual(['blankReason', 'noOwner', 'noPolicy']);
    expect(bad.find((b) => b.name === 'noOwner')?.missing).toContain('owner');
    expect(bad.find((b) => b.name === 'noPolicy')?.missing).toContain('trackedIssuePolicy');
    expect(bad.find((b) => b.name === 'blankReason')?.missing).toContain('reason');
  });
});

describe('tracked issue metadata', () => {
  it('parses repo-local #123 tracking refs and rejects non-issue provenance refs', () => {
    expect(parseTrackedIssueNumber('#2442')).toBe(2442);
    expect(parseTrackedIssueNumber(' #17 ')).toBe(17);
    expect(parseTrackedIssueNumber('ADR 0039')).toBeNull();
    expect(parseTrackedIssueNumber('https://github.com/nalfeo/Crawler/issues/1')).toBeNull();
  });

  it('flags invalid trackedIssuePolicy values and open-required entries without a repo-local issue ref', () => {
    const allowlist = {
      good: {
        reason: 'wire or remove pending follow-up',
        trackedIssue: '#2442',
        trackedIssuePolicy: 'open-required',
        owner: 'weapons',
      },
      badPolicy: {
        reason: 'invalid policy',
        trackedIssue: '#2',
        trackedIssuePolicy: 'forever' as AllowlistEntry['trackedIssuePolicy'],
        owner: 'tests',
      },
      badRef: {
        reason: 'open-required refs must be repo-local issues',
        trackedIssue: 'ADR 0039',
        trackedIssuePolicy: 'open-required' as const,
        owner: 'tests',
      },
    } satisfies Record<string, AllowlistEntry>;

    expect(findInvalidAllowlistPolicyEntries(allowlist)).toEqual([
      { name: 'badPolicy', invalid: ['trackedIssuePolicy'] },
      { name: 'badRef', invalid: ['trackedIssue'] },
    ]);
  });

  it('collects open-required allowlist entries and reports the ones whose issue is closed', () => {
    const allowlist = {
      keepOpen: {
        reason: 'temporary allowlist debt',
        trackedIssue: '#11',
        trackedIssuePolicy: 'open-required' as const,
        owner: 'guards',
      },
      provenanceOnly: {
        reason: 'documented indirection',
        trackedIssue: '#816',
        trackedIssuePolicy: 'reference-only' as const,
        owner: 'floor2',
      },
      another: {
        reason: 'second live debt item',
        trackedIssue: '#12',
        trackedIssuePolicy: 'open-required' as const,
        owner: 'guards',
      },
    } satisfies Record<string, AllowlistEntry>;

    const tracked = collectOpenRequiredTrackedIssues(allowlist);
    expect(tracked).toEqual([
      { name: 'another', trackedIssue: '#12', issueNumber: 12 },
      { name: 'keepOpen', trackedIssue: '#11', issueNumber: 11 },
    ]);

    const states = new Map<number, 'open' | 'closed'>([
      [11, 'open'],
      [12, 'closed'],
    ]);
    expect(findClosedTrackedIssueEntries(tracked, states)).toEqual([
      { name: 'another', trackedIssue: '#12' },
    ]);
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
  const entry: AllowlistEntry = {
    reason: 'r',
    trackedIssue: '#1',
    trackedIssuePolicy: 'reference-only',
    owner: 'o',
  };

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
    expect(findInvalidAllowlistPolicyEntries(ALLOWLIST)).toEqual([]);
    // Belt-and-braces: assert each required key is a non-empty string.
    for (const [name, e] of Object.entries(ALLOWLIST)) {
      for (const field of REQUIRED_ALLOWLIST_FIELDS) {
        const value = e[field];
        expect(
          typeof value === 'string' && value.trim().length > 0,
          `ALLOWLIST["${name}"].${field} must be a non-empty string`,
        ).toBe(true);
      }
      expect(
        e.trackedIssuePolicy === 'reference-only' || e.trackedIssuePolicy === 'open-required',
        `ALLOWLIST["${name}"].trackedIssuePolicy must classify the reference as provenance-only or live debt`,
      ).toBe(true);
    }
  });

  it('no allowlist entry is stale (system gone) or redundant (now wired)', () => {
    expect(findStaleAllowlistEntries(realSystems, realWiredRefs, ALLOWLIST)).toEqual([]);
  });

  it('the real shared-core fallback is recognized without a scene witness', () => {
    expect(realWiredRefs.has('fovSystem')).toBe(true);
  });

  it('the real tree exports the systems the guard is meant to check', () => {
    const names = realSystems.map((s) => s.name);
    expect(names).toContain('movementSystem');
    expect(names).toContain('spawnerSystem');
    expect(realSystems.length).toBeGreaterThan(20);
    // The real tree must stay comfortably above the partial-scan floor.
    expect(realSystems.length).toBeGreaterThanOrEqual(MIN_EXPECTED_SYSTEMS);
  });
});
