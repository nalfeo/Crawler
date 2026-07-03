/**
 * Pure helpers for `sprites:ingest-once` CLI.
 *
 * Extracted so tests can import them without triggering `ingest-once-cli.ts`'s
 * top-level `main()` (which would instantiate real Azure/GH clients on import).
 */

import type {
  AssetRequestIssueApi,
  OpenAssetRequestIssue,
} from './sidecar/asset-request-issue-api.js';
import type { IssueIngesterStatus } from './sidecar/issue-ingester-controller.js';

/**
 * Resolves the identifier stamped onto queued messages as `requestedBy`. In CI
 * this is normally `$GITHUB_ACTOR` (set by GitHub Actions); locally it falls
 * back to whichever user identifier the platform exposes.
 */
export function resolveRequestedBy(env: NodeJS.ProcessEnv): string {
  return env['GITHUB_ACTOR'] ?? env['USER'] ?? env['USERNAME'] ?? 'ci-ingest';
}

/**
 * Maps an ingester status snapshot to a process exit code. Any populated
 * `lastError` fails the CI step; missing/empty means the poll cycle finished
 * cleanly (with 0 or more items enqueued).
 */
export function exitCodeForStatus(status: IssueIngesterStatus): number {
  return status.lastError ? 1 : 0;
}

/**
 * Parses `SPRITES_INGESTER_ALLOWED_AUTHORS` (comma-separated GitHub logins)
 * into a lowercase set. Returns `null` when the env var is unset/empty, which
 * means "no author filter — process every issue that already passed upstream
 * label + body checks".
 *
 * The CI workflow sets this to `${{ github.repository_owner }}` to make sure a
 * public drive-by user can't piggyback on a maintainer-triggered run (the
 * ingester scans EVERY open `asset-request` issue on each poll, regardless of
 * which specific issue triggered the workflow). Local sidecar runs leave it
 * unset and preserve the existing behavior.
 */
export function resolveAllowedAuthorLogins(env: NodeJS.ProcessEnv): ReadonlySet<string> | null {
  const raw = env['SPRITES_INGESTER_ALLOWED_AUTHORS'];
  if (typeof raw !== 'string') return null;
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return set.size > 0 ? set : null;
}

/**
 * Filters a list of issues to those whose author login is in the allow-set.
 * Issues with an unknown/missing `authorLogin` are REJECTED under a whitelist
 * (fail-closed) — the safer default when the trust boundary is unclear.
 */
export function filterIssuesByAllowedAuthors(
  issues: readonly OpenAssetRequestIssue[],
  allowed: ReadonlySet<string>,
): readonly OpenAssetRequestIssue[] {
  return issues.filter(
    (issue) =>
      typeof issue.authorLogin === 'string' && allowed.has(issue.authorLogin.toLowerCase()),
  );
}

/**
 * Wraps an issue API so `listOpenAssetRequestIssues` returns only issues whose
 * author is in the allow-set. `comment` passes through unchanged — commenting
 * on a rejected drive-by issue never happens because the ingester only
 * comments on issues it dequeues from the queue, and rejected issues are
 * never enqueued in the first place.
 */
export function withAuthorAllowList(
  api: AssetRequestIssueApi,
  allowed: ReadonlySet<string>,
): AssetRequestIssueApi {
  return {
    async listOpenAssetRequestIssues() {
      const all = await api.listOpenAssetRequestIssues();
      return filterIssuesByAllowedAuthors(all, allowed);
    },
    comment: (issueNumber, body) => api.comment(issueNumber, body),
  };
}
