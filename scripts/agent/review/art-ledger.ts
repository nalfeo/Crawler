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
