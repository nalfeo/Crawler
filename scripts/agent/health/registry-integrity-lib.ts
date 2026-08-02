/**
 * registry-integrity-lib.ts — Pure logic for the data-registry ID integrity
 * guard. No file I/O, no `process.exit`, no console output — every input is a
 * pre-parsed `RegistrySource`, so the logic is fully unit-testable against
 * in-memory fixtures.
 *
 * ## What this catches
 *
 * Four classes of data-registry defect, all of which have reddened the suite
 * or shipped broken content before:
 *
 * 1. **Duplicate ID within one registry file** — the abilities registry grew a
 *    duplicate `id`, which made the Zod schema parse throw at module load and
 *    reddened *every* test that transitively imported the registry. A parse
 *    failure at import time gives a stack trace pointing at the loader, not at
 *    the offending row, so the real fault is expensive to locate.
 *
 * 2. **Duplicate ID ACROSS files sharing one logical namespace** — this is the
 *    new capability. `achievements.floor1.json` and `achievements.floor2.json`
 *    are two files but ONE achievement ID space (they are concatenated by the
 *    consumer). Per-file loaders each validate their own file and both pass, so
 *    two sibling PRs can independently add the same tier ID and only collide
 *    once both are on main — exactly the Floor-2 achievements `tier4` schema
 *    collision. No per-file check can ever catch this; the check must see all
 *    files in a namespace at once.
 *
 * 3. **Empty / blank / non-string IDs** — an entry with `""`, `"   "`, a
 *    number, `null`, or a missing `id` silently collapses into a single bucket
 *    downstream (or throws far from the source row).
 *
 * 4. **Missing or unparseable registry file** — a renamed or truncated
 *    registry must be a *finding with a path and a remediation*, not an
 *    uncaught exception from the guard itself.
 *
 * ## Purity contract
 *
 * `checkRegistryIntegrity` takes `readonly RegistrySource[]` and returns
 * `readonly RegistryFinding[]`. All filesystem access lives in the thin CLI
 * (`check-registry-integrity.ts`), which reads each `REGISTRY_FILES` spec and
 * hands the parsed JSON to `extractEntries` — also pure — before calling the
 * checker. That split is why a fixture-only unit test can cover every finding
 * type without touching the disk.
 *
 * ## Speed
 *
 * Pure JSON reads and set maths over a few hundred rows. No simulation, no
 * git, no subprocess — safe for `verify:fast`.
 */

/**
 * One entry read out of a registry file.
 *
 * `id` is deliberately typed `unknown` rather than `string`: the whole point of
 * finding class (3) is to catch rows whose `id` is NOT a string. Narrowing at
 * the type level here would make the invalid-id check unreachable for real
 * JSON input.
 */
export interface RegistryEntryRef {
  /** The raw value of the entry's ID field, exactly as parsed from JSON. */
  readonly id: unknown;
  /** Zero-based position of the entry inside its file, for locating the row. */
  readonly index: number;
}

/** A single registry file's parsed contents, plus its namespace membership. */
export interface RegistrySource {
  /** Stable logical source id, e.g. `achievements.floor1`. */
  readonly id: string;
  /** Repo-relative POSIX path, used verbatim in finding output. */
  readonly path: string;
  /**
   * Logical ID namespace. Sources that share a scope share ONE ID space and
   * are cross-checked against each other.
   */
  readonly scope: string;
  /** Entries in file order. Empty when `loadError` is set. */
  readonly entries: readonly RegistryEntryRef[];
  /**
   * Set when the file could not be read, parsed, or shaped as expected. The
   * source then yields exactly one `load-error` finding and no ID checks.
   */
  readonly loadError?: string;
}

/** What class of violation a finding represents. */
export type RegistryFindingKind =
  | 'duplicate-in-file'
  | 'duplicate-across-files'
  | 'invalid-id'
  | 'load-error';

/** A single actionable problem found in the registries. */
export interface RegistryFinding {
  readonly kind: RegistryFindingKind;
  /** Repo-relative path of the file the reader should open. */
  readonly file: string;
  /** Logical namespace the file belongs to. */
  readonly scope: string;
  /** The offending ID, rendered for display (`JSON.stringify` for non-strings). */
  readonly entryId: string;
  /** Zero-based index of the offending entry within its file. */
  readonly index: number;
  /** Human-readable explanation of what is wrong. */
  readonly detail: string;
  /** The concrete next action that makes the finding go away. */
  readonly remediation: string;
}

/** How to pull entries out of one registry file's parsed JSON. */
export interface RegistryFileSpec {
  /** Stable logical source id, e.g. `achievements.floor1`. */
  readonly id: string;
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Logical ID namespace shared with sibling files. */
  readonly scope: string;
  /**
   * When set, entries live at `parsed[entriesKey]`; otherwise the top-level
   * value must itself be the array.
   */
  readonly entriesKey?: string;
  /** Name of the ID field on each entry. */
  readonly idField: string;
}

/**
 * The registry files this guard covers.
 *
 * `achievements.floor1` and `achievements.floor2` deliberately share the
 * `achievements` scope: they are separate files but one achievement ID space,
 * and the cross-file check is the only thing standing between two sibling PRs
 * and a same-ID collision that neither PR's CI can see on its own.
 */
export const REGISTRY_FILES: readonly RegistryFileSpec[] = [
  {
    id: 'achievements.floor1',
    path: 'src/shared/data/achievements.floor1.json',
    scope: 'achievements',
    idField: 'id',
  },
  {
    id: 'achievements.floor2',
    path: 'src/shared/data/achievements.floor2.json',
    scope: 'achievements',
    idField: 'id',
  },
  {
    id: 'boss-abilities.floor2',
    path: 'src/shared/data/boss-abilities.floor2.json',
    scope: 'boss-abilities',
    entriesKey: 'entries',
    idField: 'id',
  },
  {
    id: 'weapons',
    path: 'src/shared/data/weapons.json',
    scope: 'weapons',
    idField: 'id',
  },
];

/** Render any ID value for human-readable output. */
export function displayId(id: unknown): string {
  return typeof id === 'string' ? id : (JSON.stringify(id) ?? String(id));
}

/** True when `id` is a usable registry key: a string with non-blank content. */
export function isUsableId(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0;
}

/** Result of pulling entries out of one parsed registry file. */
export interface ExtractResult {
  readonly entries: readonly RegistryEntryRef[];
  /** Set when the parsed JSON does not have the shape the spec expects. */
  readonly error?: string;
}

/**
 * Pure shape-extraction: turn one file's parsed JSON into `RegistryEntryRef`s.
 *
 * Handles both real shapes in this repo — a top-level array (achievements,
 * weapons) and an object with an entries key (boss-abilities). A shape
 * mismatch returns an `error` string rather than throwing, so the CLI can
 * report it as a finding.
 */
export function extractEntries(parsed: unknown, spec: RegistryFileSpec): ExtractResult {
  let raw: unknown = parsed;

  if (spec.entriesKey !== undefined) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        entries: [],
        error: `expected a JSON object with an "${spec.entriesKey}" array, got ${describeShape(parsed)}`,
      };
    }
    raw = (parsed as Record<string, unknown>)[spec.entriesKey];
    if (!Array.isArray(raw)) {
      return {
        entries: [],
        error: `expected "${spec.entriesKey}" to be an array, got ${describeShape(raw)}`,
      };
    }
  } else if (!Array.isArray(raw)) {
    return { entries: [], error: `expected a top-level JSON array, got ${describeShape(raw)}` };
  }

  const entries: RegistryEntryRef[] = (raw as readonly unknown[]).map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { id: undefined, index };
    }
    return { id: (entry as Record<string, unknown>)[spec.idField], index };
  });

  return { entries };
}

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value === undefined) return 'undefined (key absent)';
  return `a ${typeof value}`;
}

/**
 * Check every registry source for ID-integrity violations.
 *
 * Order of checks per source, which is also the order findings are emitted:
 *   1. `load-error` — if the source failed to load, report it and skip its IDs.
 *   2. `invalid-id` — non-string, empty, or blank IDs (these are excluded from
 *      the duplicate checks so one bad row cannot cascade).
 *   3. `duplicate-in-file` — the same usable ID appearing twice in one file.
 *      The first occurrence is the anchor; every later one is reported.
 *   4. `duplicate-across-files` — a usable ID already claimed by an EARLIER
 *      source in the same `scope`. A within-file duplicate is reported once
 *      (as class 3) and never double-reported here.
 *
 * Sources are processed in the order given, so the first file in a scope owns
 * an ID and later files are the ones flagged — deterministic output regardless
 * of Map iteration concerns.
 */
export function checkRegistryIntegrity(
  sources: readonly RegistrySource[],
): readonly RegistryFinding[] {
  const findings: RegistryFinding[] = [];

  /** scope → (id → path of the source that first claimed it). */
  const scopeOwners = new Map<string, Map<string, string>>();

  for (const source of sources) {
    if (source.loadError !== undefined) {
      findings.push({
        kind: 'load-error',
        file: source.path,
        scope: source.scope,
        entryId: '',
        index: -1,
        detail: `Registry '${source.id}' could not be loaded: ${source.loadError}`,
        remediation:
          `Restore ${source.path} (or update REGISTRY_FILES in ` +
          `scripts/agent/health/registry-integrity-lib.ts if the file moved or was renamed).`,
      });
      continue;
    }

    const owners = scopeOwners.get(source.scope) ?? new Map<string, string>();
    scopeOwners.set(source.scope, owners);

    /** IDs already seen in THIS file, so a dup is reported once, not twice. */
    const seenInFile = new Set<string>();

    for (const entry of source.entries) {
      if (!isUsableId(entry.id)) {
        findings.push({
          kind: 'invalid-id',
          file: source.path,
          scope: source.scope,
          entryId: displayId(entry.id),
          index: entry.index,
          detail:
            `Entry at index ${entry.index} has an unusable id (${displayId(entry.id)}). ` +
            `Registry ids must be non-empty, non-blank strings.`,
          remediation: `Give the entry at index ${entry.index} of ${source.path} a unique non-empty string id.`,
        });
        continue;
      }

      const id = entry.id;

      if (seenInFile.has(id)) {
        findings.push({
          kind: 'duplicate-in-file',
          file: source.path,
          scope: source.scope,
          entryId: id,
          index: entry.index,
          detail:
            `Duplicate id '${id}' at index ${entry.index} — the same id already appears ` +
            `earlier in this file. A duplicate id makes the registry's schema parse throw at ` +
            `module load, which reddens every test that imports it.`,
          remediation: `Rename or delete the duplicate '${id}' entry at index ${entry.index} of ${source.path}.`,
        });
        continue;
      }
      seenInFile.add(id);

      const owner = owners.get(id);
      if (owner !== undefined) {
        findings.push({
          kind: 'duplicate-across-files',
          file: source.path,
          scope: source.scope,
          entryId: id,
          index: entry.index,
          detail:
            `Cross-file duplicate id '${id}' at index ${entry.index}: already defined in ` +
            `${owner}. These files share the '${source.scope}' id namespace, so per-file ` +
            `validation passes on each side while the merged namespace is broken.`,
          remediation:
            `Rename the '${id}' entry in ${source.path} (or in ${owner}) so the ` +
            `'${source.scope}' namespace has one owner per id.`,
        });
        continue;
      }
      owners.set(id, source.path);
    }
  }

  return findings;
}

/** Total number of entries checked across all successfully loaded sources. */
export function countEntries(sources: readonly RegistrySource[]): number {
  return sources.reduce((sum, s) => sum + (s.loadError === undefined ? s.entries.length : 0), 0);
}
