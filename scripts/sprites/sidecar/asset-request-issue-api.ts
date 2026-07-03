import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ASSET_REQUEST_LABEL, parseAssetRequestIssueBody } from '../asset-request.js';

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
  comment(issueNumber: number, body: string): Promise<void>;
}

interface GhIssueListItem {
  readonly number?: unknown;
  readonly body?: unknown;
  readonly author?: unknown;
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
        if (!parseAssetRequestIssueBody(row.body)) continue;
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
  };
}
