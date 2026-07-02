/**
 * orphaned-systems-lib.ts — pure logic for the "orphaned ECS system" wiring
 * guard, built on the TypeScript compiler API (AST) rather than regex/text
 * matching.
 *
 * File I/O and reporting live in the thin `orphaned-systems.ts` wrapper; this
 * module only parses in-memory `{ path, content }` records so the parsing and
 * set maths can be unit-tested directly against synthetic file contents.
 *
 * ## Why AST, not regex
 *
 * An earlier draft scanned comment-stripped text for `*System` tokens. Two
 * separate-model reviews proved that unsafe: a string literal `"spawnerSystem"`
 * counted as a real wiring reference, a URL like `http://x/spawnerSystem`
 * truncated a genuine reference when stripping `//`, and `export { fooSystem }`
 * / re-export forms were invisible so a system could be silently unguarded.
 * Parsing the AST fixes all three: identifiers are only collected from real code
 * nodes (never strings/comments), and export specifiers are first-class.
 *
 * ## Why this guard exists
 *
 * A whole gameplay feature (`spawnerSystem`: Rats Nest / Slime Pool trickle
 * children, `spawnerPulse` VFX, `SpawnAnim` pop-in) shipped "validated by
 * actually seeing" — yet it was NEVER called in either real game pipeline. It
 * ran ONLY inside `src/labs/spawner-lab/index.ts`, which force-calls
 * `spawnerSystem(this.world)` directly. A lab force-calls the system under test,
 * so a green lab proves the system works in isolation but can NEVER prove the
 * real game calls it. "Observe before done" was satisfied in the wrong artifact
 * and nothing deterministic asserted the system was wired into a real runtime
 * pipeline. (Fix: PR #665 / ADR 0036. Process guard: ADR 0039.)
 *
 * ## What this guard asserts
 *
 * Every `*System` function exported from `src/core/**` or `src/game/**` must be
 * referenced by at least one REAL pipeline entry point (see `WIRING_SITES`) — as
 * a call expression `fooSystem(world)` or as an element of a pipeline array
 * (`preSystems: [fooSystem, …]`) — OR appear on the documented `ALLOWLIST`.
 * Lab and test references, imports, strings, and comments do NOT count.
 */

import ts from 'typescript';

/** A `*System` function definition discovered in the source tree. */
export interface SystemDef {
  /** The exported identifier, e.g. `spawnerSystem`. */
  readonly name: string;
  /** Repo-relative POSIX path of the file that exports it. */
  readonly file: string;
  /**
   * `declaration` = defined here (`export function`/`export const`);
   * `reexport` = surfaced here via `export { … }` / `export … from`. Used so
   * findings point at the real implementation file rather than a barrel.
   */
  readonly kind: 'declaration' | 'reexport';
}

/** A source file's repo-relative path plus its full text content. */
export interface SourceFile {
  /** Repo-relative POSIX path, e.g. `src/game/spawners/spawnerSystem.ts`. */
  readonly path: string;
  readonly content: string;
}

/**
 * Source roots scanned for exported `*System` definitions. These are the pure
 * ECS + game-logic layers whose systems are meant to run inside a pipeline.
 */
export const SYSTEM_SOURCE_ROOTS: ReadonlyArray<string> = ['src/core', 'src/game'];

/**
 * The REAL runtime pipeline entry points. A system referenced from any of these
 * is considered wired into the shipped game and/or the headless win-rate gate.
 *
 * - `src/bootstrap/floor-main-scene-options.ts` — defines the visual game's
 *   Floor 1 `preSystems`/`postSystems` arrays (fed to the engine sim step).
 * - `src/engine/sim/simulation-step.ts` — the visual pipeline's fixed ordered
 *   ECS loop run by `MainGameScene`.
 * - `src/game/ai/simulation-step.ts` — the hand-maintained headless pipeline run
 *   by the Floor 1 win-rate gate + headless runner.
 * - `src/game/ai/headless-runner.ts` — the headless AI driver (auto-progression
 *   / auto-NPC systems live here, not in the sim steps).
 * - `src/engine/scenes/MainGameScene.ts` — the scene itself; a few systems are
 *   invoked here directly (e.g. `fovSystem`).
 *
 * Deliberately EXCLUDES `src/labs/**` and `tests/**`: a lab or test that
 * force-calls a system proves nothing about whether the real game calls it.
 *
 * NOTE: the guard only follows two structural wiring forms — a direct call
 * (`fooSystem(world)`) and a pipeline-array element (`[…, fooSystem, …]`). If a
 * future pipeline assembles systems via some other indirection (a registry, a
 * builder that takes system refs by another path), add it here or the
 * legitimately-wired system will false-positive (escape hatch: the allowlist).
 */
export const WIRING_SITES: ReadonlyArray<string> = [
  'src/bootstrap/floor-main-scene-options.ts',
  'src/engine/sim/simulation-step.ts',
  'src/game/ai/simulation-step.ts',
  'src/game/ai/headless-runner.ts',
  'src/engine/scenes/MainGameScene.ts',
];

/**
 * A documented exception for a system that is intentionally NOT wired into a
 * real floor pipeline. Structured (not a bare reason string) so an exemption
 * carries durable, enforceable metadata — the allowlist is a tracked-debt list,
 * not a mute button. Missing any required field fails the guard.
 */
export interface AllowlistEntry {
  /** Why this system is not wired into a real pipeline. Required. */
  readonly reason: string;
  /** Issue/ADR/PR reference that tracks the exemption (e.g. `#666`, `ADR 0039`). Required. */
  readonly trackedIssue: string;
  /** Who owns resolving or maintaining this exemption. Required. */
  readonly owner: string;
  /** Optional condition under which this entry should be removed. */
  readonly removeWhen?: string;
}

/** Required fields on every allowlist entry (enforced by the guard). */
export const REQUIRED_ALLOWLIST_FIELDS: ReadonlyArray<keyof AllowlistEntry> = [
  'reason',
  'trackedIssue',
  'owner',
];

/**
 * Systems intentionally NOT wired into a real floor pipeline. Never silence the
 * guard by adding a name without a real classification + tracking ref
 * (AGENTS.md rule #12). Prefer wiring or deleting over allowlisting.
 */
export const ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  // Lab/test-only helper: spawns waves of enemies from an explicit `config` for
  // isolated combat sandboxes (weapon-lab, abilities-lab) and unit tests. It
  // takes a `SpawnerConfig` arg, so it is not a `(world) => void` pipeline
  // system anyway; real floors populate enemies via floor1EnemyDirectorSystem +
  // enemyAISystem (+ spawnerSystem once #665 lands).
  enemySpawnerSystem: {
    reason:
      'Lab/test-only enemy-wave helper (takes a SpawnerConfig arg, not a (world)=>void pipeline system); production floors use floor1EnemyDirectorSystem + enemyAISystem.',
    trackedIssue: 'ADR 0039',
    owner: 'labs (abilities-lab, weapon-lab)',
    removeWhen:
      'the labs stop using it, or it is refactored into a lab-only helper module outside src/game.',
  },
  // Latent, never-wired multi-weapon feature (same failure class as
  // spawnerSystem, not yet fixed). weaponEntitySystem processes [Weapon, Owner]
  // entities, but spawnWeapon (the only producer) and the system itself are
  // called ONLY in tests — nothing in runtime spawns weapon entities. Tracked
  // in #666 for a wire-or-delete product decision; do NOT treat as permanent.
  weaponEntitySystem: {
    reason:
      'Latent multi-weapon-entity feature: processes [Weapon, Owner] entities, but its only producer (spawnWeapon) and the system are called only in tests — nothing wires it into a real pipeline. Player weapon uses the singleton weaponSystem.',
    trackedIssue: '#666',
    owner: 'weapons',
    removeWhen:
      'the feature is wired into a real pipeline (visual + headless) or removed as YAGNI per #666.',
  },
};

/** True if `name` looks like an ECS system identifier (`*System`). */
function isSystemName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*System$/.test(name);
}

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * Extract every exported `*System` name from one file via AST. Covers:
 * - `export function fooSystem(...)`
 * - `export const fooSystem = (...) => {...}` (and other exported var decls)
 * - `export { fooSystem }`, `export { x as barSystem }`,
 *   `export { fooSystem } from './fooSystem.js'`
 * The *exported* name is what matters (so `x as barSystem` yields `barSystem`).
 */
export function extractSystemDefs(file: SourceFile): SystemDef[] {
  const sf = parse(file);
  const declared = new Set<string>();
  const reexported = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      if (isSystemName(node.name.text)) declared.add(node.name.text);
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && isSystemName(decl.name.text)) {
          declared.add(decl.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const spec of node.exportClause.elements) {
        // `spec.name` is the exported (outward-facing) identifier.
        if (isSystemName(spec.name.text)) reexported.add(spec.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const defs: SystemDef[] = [];
  for (const name of declared) defs.push({ name, file: file.path, kind: 'declaration' });
  // A name declared here is a declaration, not a re-export, even if both forms
  // appear in the same file.
  for (const name of reexported) {
    if (!declared.has(name)) defs.push({ name, file: file.path, kind: 'reexport' });
  }
  return defs;
}

/**
 * Extract the set of `*System` identifiers *wired* in one file via AST. A name
 * counts only when used as one of two structural forms:
 *   1. a direct call:            `fooSystem(world)`
 *   2. a pipeline-array element: `preSystems: [fooSystem, …]`
 * Identifiers inside imports, strings, comments, type positions, or bare
 * assignments do NOT count — matching how systems are actually wired and
 * rejecting the false-confidence signals the reviewers flagged.
 */
export function extractReferencedSystems(file: SourceFile): Set<string> {
  const sf = parse(file);
  const refs = new Set<string>();

  const visit = (node: ts.Node): void => {
    // Form 1: direct call expression with an identifier callee.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (isSystemName(node.expression.text)) refs.add(node.expression.text);
    }
    // Form 2: identifier used as an array-literal element (pipeline arrays).
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isIdentifier(el) && isSystemName(el.text)) refs.add(el.text);
        // Support spreads of identifiers too: `[...coreSystems, fooSystem]`
        else if (
          ts.isSpreadElement(el) &&
          ts.isIdentifier(el.expression) &&
          isSystemName(el.expression.text)
        ) {
          refs.add(el.expression.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return refs;
}

/**
 * Collect all exported `*System` definitions across the given source files,
 * deduped by name. Prefers the concrete declaration file over a re-export
 * barrel so findings point at the real implementation. Ties (path sort →
 * deterministic first-seen) are broken by path. `.test.ts` / `.spec.ts` files
 * are ignored.
 */
export function collectExportedSystems(files: ReadonlyArray<SourceFile>): SystemDef[] {
  const byName = new Map<string, SystemDef>();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (/\.(test|spec)\.ts$/.test(file.path)) continue;
    for (const def of extractSystemDefs(file)) {
      const existing = byName.get(def.name);
      if (!existing) byName.set(def.name, def);
      // Upgrade a re-export attribution to the concrete declaration when found.
      else if (existing.kind === 'reexport' && def.kind === 'declaration') {
        byName.set(def.name, def);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Union of all `*System` identifiers wired across the wiring-site files. */
export function collectWiredRefs(wiringFiles: ReadonlyArray<SourceFile>): Set<string> {
  const wired = new Set<string>();
  for (const file of wiringFiles) {
    for (const ref of extractReferencedSystems(file)) wired.add(ref);
  }
  return wired;
}

/** A system that is neither wired into a real pipeline nor allowlisted. */
export interface OrphanFinding {
  readonly name: string;
  readonly file: string;
}

export interface FindOrphansInput {
  readonly systems: ReadonlyArray<SystemDef>;
  readonly wiredRefs: ReadonlySet<string>;
  readonly allowlist?: Readonly<Record<string, AllowlistEntry>>;
}

/**
 * Return the systems that are defined but neither referenced by a real pipeline
 * wiring site nor present on the allowlist. Deterministic, sorted by name.
 */
export function findOrphanedSystems(input: FindOrphansInput): OrphanFinding[] {
  const allowlist = input.allowlist ?? {};
  const orphans: OrphanFinding[] = [];
  for (const sys of input.systems) {
    if (input.wiredRefs.has(sys.name)) continue;
    if (Object.prototype.hasOwnProperty.call(allowlist, sys.name)) continue;
    orphans.push({ name: sys.name, file: sys.file });
  }
  return orphans.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A stale allowlist entry: either the named system no longer exists (`missing`)
 * or it is now actually wired into a real pipeline, making the exemption
 * redundant (`redundant`). Both should be removed to keep the allowlist honest.
 */
export interface StaleAllowlistFinding {
  readonly name: string;
  readonly kind: 'missing' | 'redundant';
}

/**
 * Find allowlist entries that should be removed — either because the system is
 * gone or because it is now wired. Requires the wired-ref set so it can detect
 * the "allowlisted but now wired" case (per ADR 0039).
 */
export function findStaleAllowlistEntries(
  systems: ReadonlyArray<SystemDef>,
  wiredRefs: ReadonlySet<string>,
  allowlist: Readonly<Record<string, AllowlistEntry>> = ALLOWLIST,
): StaleAllowlistFinding[] {
  const defined = new Set(systems.map((s) => s.name));
  const findings: StaleAllowlistFinding[] = [];
  for (const name of Object.keys(allowlist)) {
    if (!defined.has(name)) findings.push({ name, kind: 'missing' });
    else if (wiredRefs.has(name)) findings.push({ name, kind: 'redundant' });
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name));
}

/** An allowlist entry missing one or more required fields. */
export interface MalformedAllowlistFinding {
  readonly name: string;
  readonly missing: string[];
}

/**
 * Find allowlist entries missing a required field (reason / trackedIssue /
 * owner). A blank or whitespace-only value counts as missing. This makes the
 * allowlist enforceable rather than a soft escape hatch.
 */
export function findMalformedAllowlistEntries(
  allowlist: Readonly<Record<string, AllowlistEntry>> = ALLOWLIST,
): MalformedAllowlistFinding[] {
  const findings: MalformedAllowlistFinding[] = [];
  for (const [name, entry] of Object.entries(allowlist)) {
    const missing = REQUIRED_ALLOWLIST_FIELDS.filter((field) => {
      const value = entry[field];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (missing.length > 0) findings.push({ name, missing });
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name));
}
