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
 * referenced by at least one sim-side/shared pipeline entry point (see
 * `WIRING_SITES`) — as a call expression `fooSystem(world)` (including an
 * invoked nullish fallback such as `(override ?? fooSystem)(world)`) or as an
 * element of a pipeline array (`preSystems: [fooSystem, …]`) — OR appear on the
 * documented `ALLOWLIST`. Visual-scene-only, lab, and test references, imports,
 * strings, comments, and bare assignments do NOT count.
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
 * A conservative lower bound on how many `*System` exports the guard expects to
 * enumerate. The repo has far more than this today; the floor exists purely as
 * defense-in-depth against a PARTIAL scan regression (the file walker silently
 * returning a handful of files instead of the whole tree), which a plain
 * "exactly zero" check would miss. If a legitimate shrink ever trips this,
 * lower it deliberately in the same commit that removes the systems.
 */
export const MIN_EXPECTED_SYSTEMS = 10;

/**
 * The trusted sim-side/shared runtime pipeline entry points. A system referenced
 * from any of these is considered reachable below the visual scene boundary.
 *
 * - `src/bootstrap/floor-main-scene-options.ts` — canonical floor
 *   `preSystems`/`postSystems` arrays consumed by BOTH the visual scene and
 *   `headless-runner.ts`.
 * - `src/core/simulation-core-step.ts` — shared deterministic core ECS step used
 *   by both visual and headless wrappers.
 * - `src/engine/sim/simulation-step.ts` — visual wrapper around the shared core
 *   step, plus scene hooks.
 * - `src/game/ai/simulation-step.ts` — headless wrapper around the shared core
 *   step used by the Floor 1 win-rate gate + headless runner.
 * - `src/game/ai/headless-runner.ts` — the headless AI driver (auto-progression
 *   / auto-NPC systems live here, not in the sim steps).
 *
 * Deliberately EXCLUDES `src/engine/scenes/MainGameScene.ts`, `src/labs/**`, and
 * `tests/**`: a scene-only reference does not prove the AI/headless simulation
 * reaches a system, while a lab or test force-call proves nothing about runtime
 * wiring.
 *
 * NOTE: the guard only follows two structural wiring forms — a direct call
 * (`fooSystem(world)`) and a pipeline-array element (`[…, fooSystem, …]`). If a
 * future pipeline assembles systems via some other indirection (a registry, a
 * builder that takes system refs by another path), add it here or the
 * legitimately-wired system will false-positive (escape hatch: the allowlist).
 */
export const WIRING_SITES: ReadonlyArray<string> = [
  'src/bootstrap/floor-main-scene-options.ts',
  'src/core/simulation-core-step.ts',
  'src/engine/sim/simulation-step.ts',
  'src/game/ai/simulation-step.ts',
  'src/game/ai/headless-runner.ts',
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
  // Floor 2 ambient director is intentionally invoked via `floor2ObjectiveTick`
  // (world.floorObjectiveTick), not as a standalone pipeline stage. The objective
  // tick is wired in real runtime/headless pipelines for Floor 2, and owns
  // ordering relative to victory/timer evaluation.
  floor2EnemyDirectorSystem: {
    reason:
      'Intentionally called from floor2ObjectiveTick (world.floorObjectiveTick) so Floor 2 objective progression and ambient pressure stay in one deterministic tick path; not wired as a standalone pipeline stage.',
    trackedIssue: '#816',
    owner: 'enemies/floor2',
    removeWhen:
      'Floor 2 objective/director ordering is refactored into explicit pipeline stages in both visual and headless runners.',
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
 * - `export function fooSystem(...)` (incl. `export default function fooSystem`)
 * - `export const fooSystem = (...) => {...}` (and other exported var decls)
 * - `export { fooSystem }`, `export { x as barSystem }`,
 *   `export { fooSystem } from './fooSystem.js'`
 * - `export default fooSystem` / `export = fooSystem` where `fooSystem` is a
 *   *local* declaration in the same file — classified as a `declaration` (the
 *   file IS the implementation), so duplicate-name detection and implementation-
 *   file attribution both work. Only when the identifier forwards a non-local
 *   (imported) symbol is it recorded as a `reexport`. Otherwise a system shipped
 *   via a default assignment would be invisible to the guard (false-clean).
 * The *exported* name is what matters (so `x as barSystem` yields `barSystem`).
 *
 * KNOWN BLIND SPOT (accepted): destructured exports —
 * `export const { fooSystem } = registry` — are not enumerated (the binding is an
 * ObjectBindingPattern, not an Identifier). ECS systems are standalone functions,
 * never destructured out of a registry, so this pattern does not occur here; the
 * allowlist remains the escape hatch if it ever does.
 */
export function extractSystemDefs(file: SourceFile): SystemDef[] {
  const sf = parse(file);
  const declared = new Set<string>();
  const reexported = new Set<string>();
  // Every `*System` bound by a local declaration in this file, regardless of
  // whether it carries an `export` modifier. Used to decide whether an
  // `export default <ident>` / `export = <ident>` names a local implementation
  // (→ declaration) or forwards an imported symbol (→ reexport).
  const locallyDeclared = new Set<string>();
  const exportAssignedNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && isSystemName(node.name.text)) {
      locallyDeclared.add(node.name.text);
      if (hasExportModifier(node)) declared.add(node.name.text);
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && isSystemName(decl.name.text)) {
          locallyDeclared.add(decl.name.text);
          if (exported) declared.add(decl.name.text);
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
    } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      // `export default fooSystem` (isExportEquals=false) and
      // `export = fooSystem` (isExportEquals=true) both surface a name by
      // reference. Resolve local-vs-forwarded after the full walk (a `const`
      // may be declared before or after the assignment).
      if (isSystemName(node.expression.text)) exportAssignedNames.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const name of exportAssignedNames) {
    // A local declaration behind the assignment means THIS file is the
    // implementation; treat it as a declaration so duplicates are caught and the
    // concrete file (not a barrel) wins attribution. A forwarded/imported symbol
    // is a genuine re-export.
    if (locallyDeclared.has(name)) declared.add(name);
    else reexported.add(name);
  }

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
 *   1. a direct call:            `fooSystem(world)` or `(hook ?? fooSystem)(world)`
 *   2. a pipeline-array element: `preSystems: [fooSystem, …]`
 * Identifiers inside imports, strings, comments, type positions, or bare
 * assignments do NOT count — matching how systems are actually wired and
 * rejecting the false-confidence signals the reviewers flagged.
 *
 * KNOWN LIMITATION (accepted, trusted-oracle model): this counts ANY call or
 * array-element reference in a wiring-site file, without proving the enclosing
 * array/function is itself reached at runtime. So a dead reference inside a
 * wiring file — e.g. `const unused = [fooSystem]` or an unused local
 * `function debug(w){ fooSystem(w); }` — would mark `fooSystem` wired. This is
 * acceptable because the {@link WIRING_SITES} are a tiny, curated set of trusted
 * pipeline files: a dead system reference there is a distinct, review-catchable
 * smell, and far narrower than the failure this guard targets (a system
 * referenced ONLY by a lab and by no trusted file at all). Distinguishing
 * live from dead references would require whole-program dataflow analysis,
 * trading the guard's determinism/simplicity for a safe-direction edge. The
 * negative regression tests pin this as a conscious contract, not an accident.
 */
export function extractReferencedSystems(file: SourceFile): Set<string> {
  const sf = parse(file);
  const refs = new Set<string>();

  const collectInvokedCalleeSystems = (expression: ts.Expression): void => {
    if (ts.isParenthesizedExpression(expression)) {
      collectInvokedCalleeSystems(expression.expression);
    } else if (ts.isIdentifier(expression)) {
      if (isSystemName(expression.text)) refs.add(expression.text);
    } else if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectInvokedCalleeSystems(expression.left);
      collectInvokedCalleeSystems(expression.right);
    }
  };

  const visit = (node: ts.Node): void => {
    // Form 1: direct call expression. Nullish fallback callees count because the
    // selected branch is invoked; the same expression as a value/argument does not.
    if (ts.isCallExpression(node)) {
      collectInvokedCalleeSystems(node.expression);
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

/** A `*System` name that is declared as a real definition in two or more files. */
export interface DuplicateSystemFinding {
  readonly name: string;
  readonly files: string[];
}

/**
 * Find `*System` names that are DECLARED (not merely re-exported) in more than
 * one file. Wiring detection is name-based, so a duplicate name is ambiguous: if
 * `a/fooSystem` is wired and `b/fooSystem` is not, the single wired name would
 * mark BOTH as wired and silently hide the orphan in `b` — a false-clean in the
 * exact dangerous direction this guard exists to prevent. Surfacing duplicates
 * forces a rename so name-based matching stays sound. Re-export barrels (which
 * legitimately surface a name a second time) are excluded by the `declaration`
 * kind filter. Deterministic, sorted by name.
 */
export function findDuplicateSystemDeclarations(
  files: ReadonlyArray<SourceFile>,
): DuplicateSystemFinding[] {
  const byName = new Map<string, Set<string>>();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (/\.(test|spec)\.ts$/.test(file.path)) continue;
    for (const def of extractSystemDefs(file)) {
      if (def.kind !== 'declaration') continue;
      const set = byName.get(def.name) ?? new Set<string>();
      set.add(def.file);
      byName.set(def.name, set);
    }
  }
  const findings: DuplicateSystemFinding[] = [];
  for (const [name, fileSet] of byName) {
    if (fileSet.size > 1) findings.push({ name, files: [...fileSet].sort() });
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name));
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
