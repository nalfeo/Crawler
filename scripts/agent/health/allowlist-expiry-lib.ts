/**
 * allowlist-expiry-lib.ts — pure governance rules for every allowlist,
 * suppression, and exception list in the repo.
 *
 * ## Why this exists
 *
 * Suppression lists in this repo were governed inconsistently. `AUDIT_EXCEPTIONS`
 * / `TEMP_DEPENDENCY_EXCEPTIONS` (npm-audit) and `KNIP_SUPPRESSIONS` carried
 * `expiresOn` + reason-restatement rules; `ALLOWLIST` (orphaned-systems) carried
 * tracking metadata but no review deadline; `TEST_SCAFFOLD_ALLOWLIST_ENTRIES`
 * carried nothing at all. A new allowlist could be added with zero governance
 * and nothing would notice.
 *
 * This module makes the governance policy of every list explicit and checkable:
 *
 * - `time-bounded`    → the exemption is debt with a deadline. Every entry needs
 *                       a non-trivial `reason` and a real, future `expiresOn`.
 * - `tracked-permanent` → the exemption is a deliberate, indefinite design
 *                       decision. Every entry needs a non-trivial `reason`, a
 *                       tracking reference, and a stated removal condition — and
 *                       must NOT carry `expiresOn`, because a date on a list that
 *                       is never meant to expire is mis-declared governance and
 *                       trains readers to rubber-stamp date bumps.
 *
 * Plus the anti-bypass rule: any exported const in the scanned trees whose name
 * looks like an allowlist but is not registered with this checker is a finding.
 * This follows the `KNOWN_EXPIRY_ARRAY_NAMES` precedent in
 * `scripts/agent/security/npm-audit.mjs`: fail closed, so adding a new
 * ungoverned allowlist is a build failure rather than a silent regression.
 *
 * Pure by construction: no `fs`, no `console`, no `process`. All I/O and the
 * registration of real sources live in `check-allowlist-expiry.ts`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How a governed allowlist is expected to age. */
export type AllowlistGovernancePolicy = 'time-bounded' | 'tracked-permanent';

/**
 * One entry of a governed allowlist, normalised to a common shape by the caller
 * (each real list has its own field names — the CLI adapts them to this).
 */
export interface GovernedAllowlistEntry {
  /** Stable identifier of the entry within its source (e.g. `file#symbol`). */
  readonly key: string;
  /** Why this exemption exists. Required by both policies. */
  readonly reason?: string;
  /** ISO `YYYY-MM-DD` review deadline. Required by `time-bounded` only. */
  readonly expiresOn?: string;
  /** Issue / ADR / PR reference. Required by `tracked-permanent` only. */
  readonly trackingRef?: string;
  /** Condition under which the entry is removed. Required by `tracked-permanent`. */
  readonly removeWhen?: string;
}

/** A registered allowlist plus the governance policy it declares. */
export interface GovernedAllowlistSource {
  /** Exported const name of the list, e.g. `KNIP_SUPPRESSIONS`. */
  readonly name: string;
  /** Repo-relative POSIX path of the file that declares it. */
  readonly file: string;
  /** Governance policy this list declares for itself. */
  readonly policy: AllowlistGovernancePolicy;
  /** The entries to validate. */
  readonly entries: readonly GovernedAllowlistEntry[];
  /**
   * Additional exported const names that are derived from this same list (for
   * example a `Set` built from the entries array). Registering them here keeps
   * the anti-bypass scan from flagging a view of an already-governed list.
   */
  readonly alsoCoversExportNames?: readonly string[];
}

/** One rule violation. One `kind` per rule so callers can group deterministically. */
export type AllowlistFindingKind =
  | 'missing-reason'
  | 'trivial-reason'
  | 'missing-expiry'
  | 'malformed-expiry'
  | 'impossible-expiry'
  | 'expired'
  | 'missing-tracking-ref'
  | 'missing-removal-condition'
  | 'unexpected-expiry'
  | 'unregistered-allowlist';

/** A structured, reportable governance finding. */
export interface AllowlistFinding {
  readonly kind: AllowlistFindingKind;
  /** Exported const name of the offending list. */
  readonly source: string;
  /** Repo-relative POSIX path where the fix must be made. */
  readonly file: string;
  /** Entry key within the source (`'<source>'` for whole-source findings). */
  readonly entry: string;
  /** What is wrong. */
  readonly message: string;
  /** What to do about it. */
  readonly remediation: string;
}

/** An exported const discovered by the anti-bypass scan. */
export interface DiscoveredAllowlistExport {
  /** Exported const name. */
  readonly name: string;
  /** Repo-relative POSIX path of the declaring file. */
  readonly file: string;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Minimum trimmed length for a reason to count as a real justification. */
export const MIN_REASON_LENGTH = 20;

/**
 * Reasons that are placeholders rather than justifications. Compared against the
 * reason with all non-alphanumeric characters stripped, lower-cased.
 */
const PLACEHOLDER_REASONS: ReadonlySet<string> = new Set([
  'todo',
  'fixme',
  'tbd',
  'na',
  'none',
  'nocomment',
  'wip',
  'xxx',
  'temp',
  'temporary',
  'hack',
  'legacy',
  'seeabove',
]);

/** Exported const names that look like a governed allowlist. */
export const ALLOWLIST_EXPORT_NAME_RE = /(ALLOWLIST|SUPPRESSIONS|EXCEPTIONS|EXEMPTIONS)/;

/** Matches `export const FOO_ALLOWLIST` style declarations in TS/JS source. */
const EXPORTED_CONST_RE = /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/gm;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a syntactically well-formed AND real calendar date. */
export function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trip guards against JS date rollover (2026-02-30 → 2026-03-02).
  return parsed.toISOString().slice(0, 10) === value;
}

/** True when `value` is shaped like `YYYY-MM-DD`, real calendar date or not. */
export function hasIsoDateShape(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

/** True when a reason is a real justification rather than a placeholder. */
export function isNonTrivialReason(reason: string | undefined): boolean {
  if (typeof reason !== 'string') return false;
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) return false;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  return !PLACEHOLDER_REASONS.has(normalized);
}

function isPresent(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Entry-level checks
// ---------------------------------------------------------------------------

function reasonFindings(
  source: GovernedAllowlistSource,
  entry: GovernedAllowlistEntry,
): AllowlistFinding[] {
  const base = { source: source.name, file: source.file, entry: entry.key } as const;

  if (!isPresent(entry.reason)) {
    return [
      {
        ...base,
        kind: 'missing-reason',
        message: `${source.name} entry "${entry.key}" has no reason.`,
        remediation:
          `Add a "reason" to the "${entry.key}" entry in ${source.file} explaining why this ` +
          `exemption exists, or delete the entry and fix the underlying problem.`,
      },
    ];
  }

  if (!isNonTrivialReason(entry.reason)) {
    return [
      {
        ...base,
        kind: 'trivial-reason',
        message:
          `${source.name} entry "${entry.key}" has a placeholder reason ` +
          `(${JSON.stringify(entry.reason)}); a reason must be at least ` +
          `${MIN_REASON_LENGTH} characters and say something specific.`,
        remediation:
          `Replace the "reason" on the "${entry.key}" entry in ${source.file} with a specific ` +
          `justification: what the symbol/package is, and why it legitimately has no ` +
          `production caller (or no upgrade) today.`,
      },
    ];
  }

  return [];
}

function timeBoundedFindings(
  source: GovernedAllowlistSource,
  entry: GovernedAllowlistEntry,
  today: string,
): AllowlistFinding[] {
  const base = { source: source.name, file: source.file, entry: entry.key } as const;

  if (!isPresent(entry.expiresOn)) {
    return [
      {
        ...base,
        kind: 'missing-expiry',
        message:
          `${source.name} entry "${entry.key}" has no expiresOn, but ${source.name} is ` +
          `governed as time-bounded.`,
        remediation:
          `Add "expiresOn: 'YYYY-MM-DD'" to the "${entry.key}" entry in ${source.file} — a ` +
          `realistic review deadline by which the exemption must be resolved.`,
      },
    ];
  }

  const expiresOn = entry.expiresOn!.trim();

  if (!hasIsoDateShape(expiresOn)) {
    return [
      {
        ...base,
        kind: 'malformed-expiry',
        message: `${source.name} entry "${entry.key}" has a malformed expiresOn "${expiresOn}".`,
        remediation: `Use an ISO calendar date in the form YYYY-MM-DD in ${source.file}.`,
      },
    ];
  }

  if (!isRealIsoDate(expiresOn)) {
    return [
      {
        ...base,
        kind: 'impossible-expiry',
        message:
          `${source.name} entry "${entry.key}" has expiresOn "${expiresOn}", which is not a ` +
          `real calendar date.`,
        remediation:
          `Correct the "expiresOn" on the "${entry.key}" entry in ${source.file} to a date that ` +
          `actually exists (month 01-12, day within that month).`,
      },
    ];
  }

  if (expiresOn < today) {
    return [
      {
        ...base,
        kind: 'expired',
        message:
          `${source.name} entry "${entry.key}" expired on ${expiresOn} (today is ${today}). ` +
          `Fix the underlying problem — don't extend the date.`,
        remediation:
          `In ${source.file}: resolve the "${entry.key}" exemption (wire it, delete it, or ` +
          `upgrade the dependency) and remove the entry. Only if the exemption is still ` +
          `genuinely needed, restate "reason" with a CURRENT justification and set a new ` +
          `"expiresOn" — a bumped date with an unchanged reason is itself a violation.`,
      },
    ];
  }

  return [];
}

function trackedPermanentFindings(
  source: GovernedAllowlistSource,
  entry: GovernedAllowlistEntry,
): AllowlistFinding[] {
  const base = { source: source.name, file: source.file, entry: entry.key } as const;
  const findings: AllowlistFinding[] = [];

  if (!isPresent(entry.trackingRef)) {
    findings.push({
      ...base,
      kind: 'missing-tracking-ref',
      message:
        `${source.name} entry "${entry.key}" has no tracking reference, but ${source.name} is ` +
        `governed as tracked-permanent.`,
      remediation:
        `Add a tracking reference (e.g. "#1234" or "ADR 0039") to the "${entry.key}" entry in ` +
        `${source.file} so the exemption has a durable, auditable owner.`,
    });
  }

  if (!isPresent(entry.removeWhen)) {
    findings.push({
      ...base,
      kind: 'missing-removal-condition',
      message:
        `${source.name} entry "${entry.key}" has no stated removal condition, so nothing ` +
        `describes when this permanent exemption stops being correct.`,
      remediation:
        `Add a "removeWhen" to the "${entry.key}" entry in ${source.file} describing the ` +
        `concrete condition under which the entry should be deleted.`,
    });
  }

  if (isPresent(entry.expiresOn)) {
    findings.push({
      ...base,
      kind: 'unexpected-expiry',
      message:
        `${source.name} entry "${entry.key}" declares expiresOn "${entry.expiresOn}", but ` +
        `${source.name} is governed as tracked-permanent, which never expires.`,
      remediation:
        `Either remove "expiresOn" from the "${entry.key}" entry in ${source.file}, or move the ` +
        `entry to a time-bounded allowlist. A deadline on a never-expiring list is ` +
        `mis-declared governance.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate every entry of every registered allowlist against its declared
 * governance policy. `today` is an ISO `YYYY-MM-DD` string (injected so the
 * rules stay pure and testable).
 */
export function findAllowlistFindings(
  sources: readonly GovernedAllowlistSource[],
  today: string,
): readonly AllowlistFinding[] {
  const findings: AllowlistFinding[] = [];

  for (const source of sources) {
    for (const entry of source.entries) {
      const reasonProblems = reasonFindings(source, entry);
      findings.push(...reasonProblems);

      if (source.policy === 'time-bounded') {
        findings.push(...timeBoundedFindings(source, entry, today));
      } else {
        findings.push(...trackedPermanentFindings(source, entry));
      }
    }
  }

  return findings;
}

/**
 * Extract exported const names from raw source text. Pure: the caller decides
 * which files to read and which to skip (test files declare allowlist-shaped
 * fixture strings that must not trip discovery).
 */
export function findExportedConstNames(source: string): readonly string[] {
  const names: string[] = [];
  EXPORTED_CONST_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPORTED_CONST_RE.exec(source)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

/** True when an exported const name looks like a governed allowlist. */
export function isAllowlistExportName(name: string): boolean {
  return ALLOWLIST_EXPORT_NAME_RE.test(name);
}

/**
 * Fail-closed anti-bypass rule: any discovered export whose name looks like an
 * allowlist and is not registered with this checker is a finding. Adding a new
 * ungoverned allowlist must break the build, not slip through.
 */
export function findUnregisteredAllowlists(
  discoveredExports: readonly DiscoveredAllowlistExport[],
  registeredSourceNames: readonly string[],
): readonly AllowlistFinding[] {
  const registered = new Set(registeredSourceNames);
  const findings: AllowlistFinding[] = [];
  const seen = new Set<string>();

  for (const discovered of discoveredExports) {
    if (!isAllowlistExportName(discovered.name)) continue;
    if (registered.has(discovered.name)) continue;

    const dedupeKey = `${discovered.file}#${discovered.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    findings.push({
      kind: 'unregistered-allowlist',
      source: discovered.name,
      file: discovered.file,
      entry: discovered.name,
      message:
        `Exported const "${discovered.name}" in ${discovered.file} looks like an allowlist / ` +
        `suppression list but is not registered with the allowlist-expiry checker, so it has ` +
        `no governance at all.`,
      remediation:
        `Register "${discovered.name}" in scripts/agent/health/check-allowlist-expiry.ts with a ` +
        `governance policy ('time-bounded' or 'tracked-permanent') and give every entry the ` +
        `fields that policy requires. If it is not an exemption list (e.g. it is a schema or ` +
        `path constant), add it to NON_GOVERNED_ALLOWLIST_EXPORTS there with a written reason.`,
    });
  }

  return findings;
}
