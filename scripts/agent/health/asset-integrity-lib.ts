/**
 * asset-integrity-lib.ts — Pure logic for the generated-art corpus integrity
 * check. No fs, no process, no console: the CLI does all I/O and hashing and
 * hands this module a plain array of records, so every finding class is
 * unit-testable from in-memory fixtures.
 *
 * ## What this catches
 *
 * The source of truth for approved generated art is the per-sprite shard set
 * under `public/assets/generated/entries/**\/*.json`. Each shard names a PNG
 * (`assetPath`) and, for entries approved since content hashing landed, records
 * the SHA-256 of that PNG's bytes (`contentHash`). Nothing in the normal build
 * re-verifies that pairing, which has let two real regressions through:
 *
 * 1. **Stale hash** — welcome-room PNGs were restored from an earlier commit
 *    while 55 shard `contentHash` values kept pointing at the newer bytes. Unit
 *    tests reddened downstream and needed CI-recovery intervention to untangle,
 *    because the failure surfaced far from its cause.
 *
 * 2. **Filename/identity mismatch** — a manifest-sharding PR produced a cyclic
 *    shuffle of `assetPath` values, so the Slime Rat boss rendered as a panda.
 *    Every hash still matched its own file; only the sprite→file *identity* was
 *    wrong, and only a human's eyes caught it.
 *
 * ## Finding classes
 *
 * | kind               | Meaning                                                       |
 * | ------------------ | ------------------------------------------------------------- |
 * | `hash-mismatch`    | `contentHash` present but ≠ SHA-256 of the PNG bytes           |
 * | `missing-file`     | `assetPath` points at a file that does not exist               |
 * | `name-mismatch`    | `assetPath` basename does not correspond to `spriteName`       |
 * | `duplicate-path`   | Two different sprites claim the same `assetPath`               |
 * | `duplicate-name`   | Two shards declare the same `spriteName`                       |
 * | `malformed`        | Unparseable JSON or a missing required field                   |
 *
 * A shard with **no** `contentHash` is legitimate — entries approved before
 * hashing existed never got one. Those are counted in
 * {@link IntegritySummary.unhashed} and never produce a finding.
 *
 * ## The identity rule
 *
 * Derived from the committed corpus (642 shards, zero violations at the time of
 * writing) rather than assumed. Every `assetPath` is `generated/<stem>.png`.
 * Nested sprites are addressed two equivalent ways, both of which occur:
 *
 *   - flattened:  `equipment/accessory/lucky-feather` → `generated/equipment-accessory-lucky-feather.png`
 *   - nested:     `equipment/weapon/bone-saw`         → `generated/equipment/weapon/bone-saw.png`
 *
 * and unwired concepts carry a `-placeholder` suffix on the file but not on the
 * sprite name:
 *
 *   - placeholder: `aether-dust` → `generated/aether-dust-placeholder.png`
 *
 * So the rule is: strip the `generated/` prefix, the `.png` extension, and one
 * optional trailing `-placeholder`, then flatten `/` to `-`. The result must
 * equal `spriteName` with `/` flattened to `-`. This is strict enough to catch
 * the Slime-Rat-as-panda shuffle (which swapped whole stems) while accepting
 * every shape the real corpus uses.
 */

/** The `generated/` prefix every `assetPath` is expected to carry. */
export const ASSET_PATH_PREFIX = 'generated/';

/** Suffix a placeholder PNG carries that its `spriteName` does not. */
export const PLACEHOLDER_SUFFIX = '-placeholder';

/**
 * One shard as seen by the pure checker. The CLI is responsible for reading the
 * JSON, resolving `assetPath` on disk, and hashing the bytes.
 */
export interface ShardRecord {
  /** Repo-relative POSIX path of the shard JSON, used for reporting. */
  readonly shardFile: string;
  /** Declared sprite identity, e.g. `batfolk-boss-var-0`. */
  readonly spriteName: string;
  /** Declared PNG path relative to `public/assets/`. */
  readonly assetPath: string;
  /** Recorded SHA-256 of the PNG bytes. Absent on pre-hashing entries. */
  readonly contentHash?: string;
  /** SHA-256 the CLI actually computed. Absent when the file does not exist. */
  readonly actualHash?: string;
  /** Whether `assetPath` resolved to an existing file. */
  readonly fileExists: boolean;
  /** Invalid local provenance found while parsing the shard, if any. */
  readonly provenanceViolations?: readonly string[];
}

/**
 * A shard the CLI could not turn into a {@link ShardRecord} — unparseable JSON
 * or a missing required field. Surfaced as a finding, never as a crash.
 */
export interface MalformedShard {
  /** Repo-relative POSIX path of the offending shard JSON. */
  readonly shardFile: string;
  /** Why it could not be read as a shard. */
  readonly reason: string;
}

/** What class of integrity violation was detected. */
export type FindingKind =
  | 'hash-mismatch'
  | 'missing-file'
  | 'name-mismatch'
  | 'duplicate-path'
  | 'duplicate-name'
  | 'unsafe-provenance'
  | 'malformed';

/** A single integrity violation. Every finding is blocking. */
export interface Finding {
  readonly kind: FindingKind;
  /** Repo-relative POSIX path of the shard that triggered it. */
  readonly shardFile: string;
  /** The sprite identity involved, when known. */
  readonly spriteName?: string;
  /** Human-readable explanation of what is wrong. */
  readonly detail: string;
  /** The concrete command or edit that resolves it. */
  readonly remediation: string;
}

/** Non-blocking corpus statistics, printed alongside the findings. */
export interface IntegritySummary {
  /** Shards that produced a usable record. */
  readonly shardsChecked: number;
  /** Records that carried a `contentHash` and were compared against bytes. */
  readonly hashesVerified: number;
  /** Records with no `contentHash` — informational, never a failure. */
  readonly unhashed: number;
}

/** Result of {@link checkAssetIntegrity}. */
export interface IntegrityResult {
  readonly findings: readonly Finding[];
  readonly summary: IntegritySummary;
}

/**
 * Reduce an `assetPath` to the identity it claims to represent.
 *
 * `generated/equipment/weapon/bone-saw.png` → `equipment-weapon-bone-saw`
 * `generated/aether-dust-placeholder.png`   → `aether-dust`
 *
 * Returns `null` when the path does not have the expected
 * `generated/<stem>.png` shape, which is itself a name-mismatch.
 */
export function assetPathIdentity(assetPath: string): string | null {
  if (!assetPath.startsWith(ASSET_PATH_PREFIX)) return null;
  if (!assetPath.endsWith('.png')) return null;
  const stem = assetPath.slice(ASSET_PATH_PREFIX.length, -'.png'.length);
  if (stem.length === 0) return null;
  const withoutPlaceholder = stem.endsWith(PLACEHOLDER_SUFFIX)
    ? stem.slice(0, -PLACEHOLDER_SUFFIX.length)
    : stem;
  if (withoutPlaceholder.length === 0) return null;
  return flattenIdentity(withoutPlaceholder);
}

/** Flatten a nested identity so `a/b/c` and `a-b-c` compare equal. */
export function flattenIdentity(name: string): string {
  return name.replace(/\//g, '-');
}

/**
 * Whether `assetPath`'s basename corresponds to `spriteName` under the corpus
 * identity rule documented at the top of this file.
 */
export function assetPathMatchesSpriteName(spriteName: string, assetPath: string): boolean {
  const identity = assetPathIdentity(assetPath);
  if (identity === null) return false;
  return identity === flattenIdentity(spriteName);
}

/**
 * Check the generated-art corpus for integrity violations.
 *
 * Ordering is deterministic: malformed shards first (they explain any
 * downstream gaps), then per-record findings in input order, then duplicate
 * findings grouped by the key they collide on.
 *
 * @param records - one entry per readable shard, with hashing already done
 * @param malformed - shards that could not be read at all
 */
export function checkAssetIntegrity(
  records: readonly ShardRecord[],
  malformed: readonly MalformedShard[] = [],
): IntegrityResult {
  const findings: Finding[] = [];

  for (const bad of malformed) {
    findings.push({
      kind: 'malformed',
      shardFile: bad.shardFile,
      detail: `Shard could not be read: ${bad.reason}`,
      remediation:
        `Fix or delete ${bad.shardFile}. A shard must be a JSON object with at least ` +
        `string "spriteName" and string "assetPath" fields.`,
    });
  }

  let hashesVerified = 0;
  let unhashed = 0;

  for (const record of records) {
    const {
      shardFile,
      spriteName,
      assetPath,
      contentHash,
      actualHash,
      fileExists,
      provenanceViolations = [],
    } = record;

    for (const violation of provenanceViolations) {
      findings.push({
        kind: 'unsafe-provenance',
        shardFile,
        spriteName,
        detail: `Shard contains non-portable provenance: ${violation}.`,
        remediation:
          `Replace the value in ${shardFile} with a safe repo-relative sourceRun and remove ` +
          `machine-local postprocess provenance fields.`,
      });
    }

    if (!assetPathMatchesSpriteName(spriteName, assetPath)) {
      findings.push({
        kind: 'name-mismatch',
        shardFile,
        spriteName,
        detail:
          `spriteName "${spriteName}" does not correspond to assetPath "${assetPath}". ` +
          `Expected the path to be "${ASSET_PATH_PREFIX}${spriteName}.png" (or the ` +
          `flattened / "${PLACEHOLDER_SUFFIX}" variant of it). A shard whose file and ` +
          `identity disagree renders the wrong sprite in-game while every hash still checks out.`,
        remediation:
          `Correct either "spriteName" or "assetPath" in ${shardFile} so they name the ` +
          `same sprite, then re-run: npx tsx scripts/agent/health/check-asset-integrity.ts`,
      });
    }

    if (!fileExists) {
      findings.push({
        kind: 'missing-file',
        shardFile,
        spriteName,
        detail:
          `assetPath "${assetPath}" does not exist under public/assets/. The shard is an ` +
          `orphan: nothing can load this sprite, and any consumer of it will 404.`,
        remediation:
          `Either restore the PNG at public/assets/${assetPath}, or delete the orphaned ` +
          `shard ${shardFile} if the sprite was intentionally retired.`,
      });
      // No bytes to hash against, so the hash classes below cannot be evaluated.
      if (contentHash === undefined) unhashed++;
      continue;
    }

    if (contentHash === undefined) {
      // Legitimate: entries approved before content hashing existed.
      unhashed++;
      continue;
    }

    hashesVerified++;

    if (actualHash !== undefined && actualHash !== contentHash) {
      findings.push({
        kind: 'hash-mismatch',
        shardFile,
        spriteName,
        detail:
          `contentHash is stale for "${assetPath}": shard records ${contentHash} but the ` +
          `PNG on disk hashes to ${actualHash}. Either the PNG changed without the shard ` +
          `being updated, or the shard was updated against different bytes.`,
        remediation:
          `If the PNG on disk is the intended art, set "contentHash" in ${shardFile} to ` +
          `${actualHash}. If the PNG is the wrong one, restore the correct bytes instead — ` +
          `do not update the hash to silence this.`,
      });
    }
  }

  findings.push(...duplicateFindings(records));

  return {
    findings,
    summary: {
      shardsChecked: records.length,
      hashesVerified,
      unhashed,
    },
  };
}

/**
 * Detect two shards claiming the same identity or the same file.
 *
 * `duplicate-name` is always a violation. `duplicate-path` fires only when the
 * colliding shards declare *different* sprite names — two shards with identical
 * name and path are already reported as `duplicate-name`.
 */
function duplicateFindings(records: readonly ShardRecord[]): Finding[] {
  const findings: Finding[] = [];

  const byName = groupBy(records, (r) => r.spriteName);
  for (const [spriteName, group] of byName) {
    if (group.length < 2) continue;
    const files = group.map((r) => r.shardFile).join(', ');
    for (const record of group) {
      findings.push({
        kind: 'duplicate-name',
        shardFile: record.shardFile,
        spriteName,
        detail:
          `spriteName "${spriteName}" is declared by ${group.length} shards (${files}). ` +
          `Sprite identity must be unique; whichever shard loses the merge silently ` +
          `disappears from the corpus.`,
        remediation: `Rename or delete all but one of: ${files}`,
      });
    }
  }

  const byPath = groupBy(records, (r) => r.assetPath);
  for (const [assetPath, group] of byPath) {
    const distinctNames = new Set(group.map((r) => r.spriteName));
    if (distinctNames.size < 2) continue;
    const files = group.map((r) => r.shardFile).join(', ');
    const names = [...distinctNames].sort().join(', ');
    for (const record of group) {
      findings.push({
        kind: 'duplicate-path',
        shardFile: record.shardFile,
        spriteName: record.spriteName,
        detail:
          `assetPath "${assetPath}" is claimed by ${distinctNames.size} different sprites ` +
          `(${names}) across ${files}. At most one of them can be rendering the art its ` +
          `name promises.`,
        remediation: `Give each of ${names} its own PNG, or delete the shards that are wrong.`,
      });
    }
  }

  return findings;
}

/** Group records by a derived key, preserving first-seen key order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket === undefined) out.set(k, [item]);
    else bucket.push(item);
  }
  return out;
}
