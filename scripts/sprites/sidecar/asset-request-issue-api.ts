import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ASSET_REQUEST_LABEL,
  AssetRequestValidationError,
  parseAssetRequestIssueBody,
} from '../asset-request.js';

const execFileAsync = promisify(execFile);

export interface OpenAssetRequestIssue {
  readonly number: number;
  readonly body: string;
  /**
   * GitHub username of the issue author. Populated by `createGhAssetRequestIssueApi`
   * via `gh issue list --json author`. Optional so hand-constructed mock issues in
   * tests + prior callers keep compiling without change. Consumers that want to
   * apply an author-based trust gate (see `scripts/sprites/ingest-once-cli.ts`)
   * must treat `undefined` as "unknown → reject".
   */
  readonly authorLogin?: string;
}

export interface AssetRequestIssueApi {
  listOpenAssetRequestIssues(): Promise<readonly OpenAssetRequestIssue[]>;
  /**
   * Fetch a single asset-request issue by number via the GitHub REST-backed
   * `gh issue view` path. This is the immediately-consistent counterpart to
   * `listOpenAssetRequestIssues`, which relies on GraphQL search indexing and
   * can lag 30–120s for very fresh issues — long enough that a workflow
   * triggered by an `issues.labeled` webhook regularly misses the issue that
   * triggered it. The ingester CLI uses `getIssue` to force-include the
   * triggering issue so newly-filed requests are never lost to search lag.
   *
   * Returns `null` when the issue exists but is not open, does not carry the
   * `asset-request` label, or has a body that doesn't parse. Callers must
   * treat that as "nothing to enqueue right now" — the sweep path will pick
   * it up later if the issue transitions back into a processable state.
   *
   * Rejects when the underlying `gh` call fails (network, auth, or the issue
   * literally doesn't exist).
   */
  getIssue(issueNumber: number): Promise<OpenAssetRequestIssue | null>;
  comment(issueNumber: number, body: string): Promise<void>;
}

interface GhIssueListItem {
  readonly number?: unknown;
  readonly body?: unknown;
  readonly author?: unknown;
  readonly labels?: unknown;
  readonly state?: unknown;
}

const OPEN_ASSET_REQUEST_ISSUE_LIMIT = '200';

export function createGhAssetRequestIssueApi(repoRoot: string): AssetRequestIssueApi {
  return {
    async listOpenAssetRequestIssues(): Promise<readonly OpenAssetRequestIssue[]> {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'issue',
          'list',
          '--label',
          ASSET_REQUEST_LABEL,
          '--state',
          'open',
          '--limit',
          OPEN_ASSET_REQUEST_ISSUE_LIMIT,
          '--json',
          'number,body,author',
        ],
        { cwd: repoRoot },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const out: OpenAssetRequestIssue[] = [];
      for (const row of parsed as GhIssueListItem[]) {
        if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number < 1)
          continue;
        if (typeof row.body !== 'string') continue;
        // Filter to issues that actually carry the machine-readable contract.
        if (!parseIssueBody(row.number, row.body)) continue;
        // `gh issue list --json author` returns `{ login, id, name, is_bot }`.
        // We only need `login` for downstream trust-gates.
        const authorLogin =
          row.author &&
          typeof row.author === 'object' &&
          'login' in row.author &&
          typeof (row.author as { login: unknown }).login === 'string'
            ? (row.author as { login: string }).login
            : undefined;
        out.push({ number: row.number, body: row.body, authorLogin });
      }
      return out;
    },
    async comment(issueNumber: number, body: string): Promise<void> {
      await execFileAsync('gh', ['issue', 'comment', String(issueNumber), '--body', body], {
        cwd: repoRoot,
      });
    },
    async getIssue(issueNumber: number): Promise<OpenAssetRequestIssue | null> {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          'gh',
          ['issue', 'view', String(issueNumber), '--json', 'number,body,author,labels,state'],
          { cwd: repoRoot },
        ));
      } catch (err) {
        // `gh issue view` exits non-zero on "not found" as well as on transient
        // errors. Rethrow so the caller (CLI) can surface it — a missing
        // triggering issue is a real error, not a silent no-op.
        throw new Error(
          `gh issue view ${issueNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== 'object') return null;
      const row = parsed as GhIssueListItem;
      if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number < 1)
        return null;
      if (typeof row.body !== 'string') return null;
      if (row.state !== 'OPEN' && row.state !== 'open') return null;
      // Enforce the label — a bare fetch-by-number could otherwise pull a
      // non-asset-request issue if a workflow was accidentally triggered with
      // the wrong number.
      const labels = Array.isArray(row.labels) ? row.labels : [];
      const hasAssetLabel = labels.some((label) => {
        if (!label || typeof label !== 'object') return false;
        const name = (label as { name?: unknown }).name;
        return typeof name === 'string' && name === ASSET_REQUEST_LABEL;
      });
      if (!hasAssetLabel) return null;
      if (!parseIssueBody(row.number, row.body)) return null;
      const authorLogin =
        row.author &&
        typeof row.author === 'object' &&
        'login' in row.author &&
        typeof (row.author as { login: unknown }).login === 'string'
          ? (row.author as { login: string }).login
          : undefined;
      return { number: row.number, body: row.body, authorLogin };
    },
  };
}

function parseIssueBody(issueNumber: number, body: string) {
  try {
    return parseAssetRequestIssueBody(body);
  } catch (error) {
    if (error instanceof AssetRequestValidationError) {
      process.stderr.write(`asset-request-issue-api: issue #${issueNumber}: ${error.message}\n`);
      return null;
    }
    throw error;
  }
}
