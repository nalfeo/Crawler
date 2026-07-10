/**
 * Art-regen ledger: the persisted suppress-list of known-bad generated art that
 * the `--art-review` visual judge keeps so it does NOT re-critique the same
 * queued asset every run (per the maintainer's requirement: "keep a ledger of
 * what needs regenerated and NOT re-critique those specific pieces until they're
 * replaced/told to").
 *
 * The pure matching/merge logic lives here (side-effect free, unit-tested) so the
 * agent script can stay an IO shell. Matching is ALIAS-AWARE: the vision model
 * labels the SAME defect inconsistently across runs ('welcome-banner' one run,
 * 'welcome-sign' / 'welcome-sign.text' the next). An entry carries an optional
 * curated `aliases` list; both suppression and dedupe match a finding's label
 * against the entry's `asset` PLUS every alias, so those variants collapse to one
 * entry instead of spawning brittle duplicates.
 */

/** One asset queued for regeneration in the persisted art-regen ledger. */
export interface ArtLedgerEntry {
  asset: string;
  /**
   * Alternate labels the model uses for the SAME queued asset. Alias-matched for
   * both suppression and dedupe so the model's inconsistent labels collapse to
   * this one entry instead of appending duplicates. Curated (authored into the
   * ledger), not inferred.
   */
  aliases?: string[];
  prop?: string;
  kind?: string;
  issue?: string;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  status: 'needs-regen' | 'resolved';
}

export interface ArtLedger {
  updated: string;
  note: string;
  assets: ArtLedgerEntry[];
}

/** Default human note stored in a fresh / rewritten art-regen ledger. */
export const DEFAULT_LEDGER_NOTE =
  'Art assets flagged as needing regeneration. The visual-review agent suppresses these from re-critique until they are removed/marked resolved.';

/**
 * Parse the persisted art-regen ledger from its raw JSON text, FAIL-CLOSED.
 *
 * A present-but-corrupt ledger must NOT silently degrade to an empty suppress-list
 * — that would re-critique every already-queued asset and violate the maintainer's
 * "don't re-critique queued art" requirement. So this throws loudly on unparseable
 * JSON, a non-object root, or a non-array `assets` field. Valid-but-lenient input
 * is still tolerated: unknown fields are ignored and entries without a string
 * `asset` are dropped (they can never match or suppress anything).
 *
 * A MISSING file is a DIFFERENT case (a first run with nothing queued yet) and is
 * the caller's responsibility to map to an empty ledger; this function only ever
 * sees file CONTENT, so reaching it with unparseable content is a real corruption.
 */
export function parseArtLedger(raw: string): ArtLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `art-regen ledger is corrupt/unparseable (${(err as Error).message}). Refusing to ` +
        `proceed with an EMPTY suppress-list, which would re-critique every already-queued ` +
        `asset. Fix or delete the ledger file.`,
      { cause: err },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(
      `art-regen ledger root must be a JSON object, got ${got}. Refusing to proceed with an ` +
        `EMPTY suppress-list, which would re-critique every already-queued asset.`,
    );
  }
  const obj = parsed as Partial<ArtLedger>;
  if (obj.assets !== undefined && !Array.isArray(obj.assets)) {
    throw new Error(
      `art-regen ledger 'assets' must be an array. Refusing to proceed with an EMPTY ` +
        `suppress-list, which would re-critique every already-queued asset.`,
    );
  }
  const assets = Array.isArray(obj.assets)
    ? obj.assets.filter((a): a is ArtLedgerEntry => typeof a?.asset === 'string')
    : [];
  return {
    updated: typeof obj.updated === 'string' ? obj.updated : '',
    note: typeof obj.note === 'string' && obj.note.length > 0 ? obj.note : DEFAULT_LEDGER_NOTE,
    assets,
  };
}

/**
 * Minimal structural shape of a model asset finding the ledger consumes. The
 * agent's richer `AssetFinding` is assignable to this.
 */
export interface LedgerFindingInput {
  asset?: unknown;
  prop?: string;
  kind?: string;
  issue?: string;
  needs_regen?: boolean;
}

/** Normalize an asset id/label for dedupe + suppression matching. */
export function normalizeAssetKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * All normalized keys that identify a ledger entry: its `asset` plus every
 * non-empty alias. Used by both suppression and dedupe so a finding matches the
 * entry regardless of which label variant the model emitted.
 */
export function entryMatchKeys(entry: ArtLedgerEntry): string[] {
  const keys = [normalizeAssetKey(entry.asset)];
  for (const alias of entry.aliases ?? []) {
    if (typeof alias === 'string' && alias.trim().length > 0) {
      keys.push(normalizeAssetKey(alias));
    }
  }
  return keys;
}

/**
 * Normalized keys of every `needs-regen` entry (asset + aliases), used to
 * suppress re-critique. Alias-aware so the model's inconsistent labels all match
 * and get dropped before they reach the ledger merge.
 */
export function suppressedAssetKeys(ledger: ArtLedger): Set<string> {
  const keys = new Set<string>();
  for (const entry of ledger.assets) {
    if (entry.status !== 'needs-regen') continue;
    for (const key of entryMatchKeys(entry)) keys.add(key);
  }
  return keys;
}

/**
 * Does a FREE-TEXT finding (a `blocking_findings` / `recommended_fixes` string, or
 * a `precise_fixes` element/action/reason) reference a queued asset whose
 * normalized key is in `suppressed`?
 *
 * The maintainer's "don't re-critique queued art" requirement has to hold across
 * EVERY finding array, not just the structured `asset_findings`. The vision model
 * routinely re-mentions a queued asset in prose ("the welcome banner is still
 * stretched") even when told not to, so this is the belt-and-suspenders post-filter
 * the agent applies to those arrays. Matching is TOKEN-BOUNDARY: the normalized
 * finding text is wrapped in dashes and each suppressed key is matched as `-key-`,
 * so a multi-word key like `welcome-banner` matches inside a sentence while a short
 * key like `rug` matches only the standalone token, never `shrug` / `drug`.
 */
export function findingTextReferencesSuppressedAsset(
  text: string,
  suppressed: ReadonlySet<string>,
): boolean {
  if (suppressed.size === 0 || typeof text !== 'string' || text.length === 0) {
    return false;
  }
  const haystack = `-${normalizeAssetKey(text)}-`;
  for (const key of suppressed) {
    if (key.length > 0 && haystack.includes(`-${key}-`)) return true;
  }
  return false;
}

/** The ledger entry (if any) whose asset or an alias matches the given label. */
function findEntryByLabel(ledger: ArtLedger, label: string): ArtLedgerEntry | undefined {
  const key = normalizeAssetKey(label);
  return ledger.assets.find((entry) => entryMatchKeys(entry).includes(key));
}

/**
 * Merge this run's `needs_regen` asset findings into the ledger. Dedupe is
 * ALIAS-AWARE: a finding whose normalized label matches an existing entry's
 * `asset` OR any of its aliases bumps that entry (seen_count/last_seen) instead
 * of appending; a genuinely new label is appended. Returns the NEW entries
 * appended this run.
 */
export function mergeAssetFindingsIntoLedger(
  ledger: ArtLedger,
  findings: readonly LedgerFindingInput[],
  isoNow: string,
): ArtLedgerEntry[] {
  const added: ArtLedgerEntry[] = [];
  for (const finding of findings) {
    if (
      finding?.needs_regen !== true ||
      typeof finding.asset !== 'string' ||
      finding.asset.trim().length === 0
    ) {
      continue;
    }
    const label = finding.asset.trim();
    const existing = findEntryByLabel(ledger, label);
    if (existing) {
      existing.last_seen = isoNow;
      existing.seen_count += 1;
      existing.status = 'needs-regen';
      if (!existing.issue && finding.issue) existing.issue = finding.issue;
      if (!existing.kind && finding.kind) existing.kind = finding.kind;
      if (!existing.prop && finding.prop) existing.prop = finding.prop;
      continue;
    }
    const entry: ArtLedgerEntry = {
      asset: label,
      prop: finding.prop,
      kind: finding.kind,
      issue: finding.issue,
      first_seen: isoNow,
      last_seen: isoNow,
      seen_count: 1,
      status: 'needs-regen',
    };
    ledger.assets.push(entry);
    added.push(entry);
  }
  return added;
}
