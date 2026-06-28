import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ASSET_REQUEST_LABEL, parseAssetRequestIssueBody } from '../asset-request.js';

const execFileAsync = promisify(execFile);

export interface OpenAssetRequestIssue {
  readonly number: number;
  readonly body: string;
}

export interface AssetRequestIssueApi {
  listOpenAssetRequestIssues(): Promise<readonly OpenAssetRequestIssue[]>;
  comment(issueNumber: number, body: string): Promise<void>;
}

interface GhIssueListItem {
  readonly number?: unknown;
  readonly body?: unknown;
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
          'number,body',
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
        out.push({ number: row.number, body: row.body });
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
