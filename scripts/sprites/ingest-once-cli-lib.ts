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
import type {
  EnqueueCommentContext,
  IssueIngesterStatus,
} from './sidecar/issue-ingester-controller.js';

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
    async getIssue(issueNumber: number) {
      const fetched = await api.getIssue(issueNumber);
      if (!fetched) return null;
      if (typeof fetched.authorLogin !== 'string') return null;
      if (!allowed.has(fetched.authorLogin.toLowerCase())) return null;
      return fetched;
    },
    comment: (issueNumber, body) => api.comment(issueNumber, body),
  };
}

/**
 * Parses `SPRITES_INGESTER_TARGET_ISSUE` to a positive integer. Returns `null`
 * for unset / empty / non-integer / non-positive values so a misconfigured
 * workflow degrades to sweep-only behavior rather than crashing.
 */
export function resolveTargetIssueNumber(env: NodeJS.ProcessEnv): number | null {
  const raw = env['SPRITES_INGESTER_TARGET_ISSUE'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function resolveTargetIssueOnly(env: NodeJS.ProcessEnv): boolean {
  return env['SPRITES_INGESTER_TARGET_ONLY'] === 'true';
}

/**
 * Parses `SPRITES_INGESTER_STALE_CLAIM_TTL_MS` to a positive integer number of
 * milliseconds. Returns `null` when unset / empty / non-integer / non-positive
 * so the controller falls back to the "strict dedup, never reclaim" default
 * used by local dev + the historical sidecar.
 */
export function resolveStaleClaimTtlMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env['SPRITES_INGESTER_STALE_CLAIM_TTL_MS'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Resolves the URL of the workflow run that spawned this ingest, used in the
 * enqueue-completion comment posted to the source issue. Reads
 * `SPRITES_INGEST_RUN_URL` explicitly (workflow-authored), and falls back to
 * composing one from the standard GitHub Actions runner env vars
 * (`GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID`) so a workflow
 * author who forgets the explicit env still gets a working link. Returns
 * `null` when we cannot build a URL, in which case no enqueue comment is
 * posted.
 */
export function resolveRunUrl(env: NodeJS.ProcessEnv): string | null {
  const explicit = env['SPRITES_INGEST_RUN_URL'];
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim();
  }
  const serverUrl = env['GITHUB_SERVER_URL'];
  const repository = env['GITHUB_REPOSITORY'];
  const runId = env['GITHUB_RUN_ID'];
  if (
    typeof serverUrl === 'string' &&
    serverUrl.trim() !== '' &&
    typeof repository === 'string' &&
    repository.trim() !== '' &&
    typeof runId === 'string' &&
    runId.trim() !== ''
  ) {
    return `${serverUrl.trim()}/${repository.trim()}/actions/runs/${runId.trim()}`;
  }
  return null;
}

/**
 * Builds the body of the "queued this issue for processing" comment the
 * ingester posts after a successful enqueue. Returns `null` when we don't
 * have a run URL to link to (nothing actionable to say — the state file
 * already tracks the claim, so posting a naked "queued" comment adds noise
 * without giving downstream automation anything to check). Includes a
 * distinct heading for the reclaim path so a re-enqueue is obvious in the
 * issue timeline.
 */
export function formatEnqueueCommentBody(input: {
  readonly context: EnqueueCommentContext;
  readonly runUrl: string | null;
}): string | null {
  if (!input.runUrl) return null;
  const heading = input.context.reclaimed
    ? '🔁 Re-queued (previous run appeared stale)'
    : '🎬 Queued for processing';
  return (
    `${heading}\n\n` +
    `- Workflow run: ${input.runUrl}\n` +
    `- Fingerprint: \`${input.context.fingerprint.slice(0, 12)}…\`\n` +
    `\n` +
    `The worker will comment again as each pipeline stage completes and post ` +
    `a final summary when the sprite is generated and uploaded. If this run ` +
    `fails or ends without a completion comment, the next ingest pass will ` +
    `automatically re-queue this issue.`
  );
}
