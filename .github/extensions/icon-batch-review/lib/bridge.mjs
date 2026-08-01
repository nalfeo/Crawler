/**
 * bridge.mjs — icon-batch-review canvas state reader + workflow dispatcher.
 *
 * Reads:
 *  - `briefs/icons/**\/*.yaml` to enumerate known batches and their icon ids
 *  - `public/assets/generated/entries/*.json` shards (local worktree) for approved icons
 *  - `origin/assets/queue` branch (via git show) for icons committed by CI runs
 *  - `briefs/icons/.icon-rejections.json` for human-rejected icons
 *  - `public/assets/generated/<iconId>.png` (local or queue branch) to serve previews
 *
 * Dispatches:
 *  - `gh workflow run icon-batch.yml` for generate/run actions
 *
 * Runs in-process inside the extension host; no network calls, no Azure.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @param {string} repoRoot
 * @param {{ warn?: (msg: string) => void }} [opts]
 */
export function createBridge(repoRoot, opts = {}) {
  const log = opts.warn ?? (() => {});
  const BRIEFS_DIR = path.join(repoRoot, 'briefs', 'icons');
  const SHARDS_DIR = path.join(repoRoot, 'public', 'assets', 'generated', 'entries');
  const GENERATED_DIR = path.join(repoRoot, 'public', 'assets', 'generated');
  const REJECTIONS_FILE = path.join(BRIEFS_DIR, '.icon-rejections.json');

  // ── Queue-branch icon cache ──────────────────────────────────────────────
  /** @type {Map<string,boolean>|null} */
  let _queueApproved = null;
  let _queueCacheTs = 0;
  const QUEUE_TTL_MS = 90_000;

  async function getQueueApprovedIds() {
    const now = Date.now();
    if (_queueApproved !== null && now - _queueCacheTs < QUEUE_TTL_MS) return _queueApproved;
    const approved = new Map();
    try {
      await execFileAsync('git', ['fetch', 'origin', 'assets/queue', '--depth=1', '--quiet'], {
        cwd: repoRoot,
        timeout: 20_000,
      });
      const { stdout: listing } = await execFileAsync(
        'git',
        [
          'ls-tree',
          '--name-only',
          '-r',
          'origin/assets/queue',
          '--',
          'public/assets/generated/entries/',
        ],
        { cwd: repoRoot },
      );
      const files = listing
        .trim()
        .split('\n')
        .filter((f) => f.endsWith('.json') && f.trim());
      // Read shards in parallel, 12 at a time
      for (let i = 0; i < files.length; i += 12) {
        await Promise.all(
          files.slice(i, i + 12).map(async (f) => {
            try {
              const { stdout } = await execFileAsync('git', ['show', `origin/assets/queue:${f}`], {
                cwd: repoRoot,
              });
              const shard = JSON.parse(stdout);
              if (shard?.spriteName) approved.set(shard.spriteName, true);
            } catch {
              /* skip corrupt/missing */
            }
          }),
        );
      }
    } catch (err) {
      log(`getQueueApprovedIds: ${err?.message ?? err}`);
    }
    _queueApproved = approved;
    _queueCacheTs = now;
    return approved;
  }

  // ── Local helpers ────────────────────────────────────────────────────────

  /** @returns {Map<string, boolean>} approved icon ids from local worktree shards */
  function loadLocalApprovedIds() {
    const approved = new Map();
    if (!existsSync(SHARDS_DIR)) return approved;
    for (const f of readdirSync(SHARDS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const shard = JSON.parse(readFileSync(path.join(SHARDS_DIR, f), 'utf8'));
        if (shard && typeof shard.spriteName === 'string') {
          approved.set(shard.spriteName, true);
        }
      } catch {
        // ignore corrupt shards
      }
    }
    return approved;
  }

  /** @returns {{ iconId: string, feedback: string, rejectedAt: string }[]} */
  function loadRejections() {
    if (!existsSync(REJECTIONS_FILE)) return [];
    try {
      return JSON.parse(readFileSync(REJECTIONS_FILE, 'utf8')) ?? [];
    } catch {
      return [];
    }
  }

  /** @returns {string[]} all YAML brief paths under briefs/icons/ */
  function collectBriefPaths() {
    if (!existsSync(BRIEFS_DIR)) return [];
    const results = [];
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.yaml')) results.push(full);
      }
    }
    walk(BRIEFS_DIR);
    return results.sort();
  }

  /** @param {string} briefPath @returns {{ id: string, concept: string, description?: string }[]} */
  function readIconBatch(briefPath) {
    // Simple YAML line reader — avoids importing js-yaml in the extension host.
    // Icon batch entries look like:
    //   iconBatch:
    //     - id: achv-first-bonk
    //       concept: "First Bonk"
    //       description: Kill your first enemy
    const lines = readFileSync(briefPath, 'utf8').split('\n');
    const entries = [];
    let inBatch = false;
    let current = null;
    for (const line of lines) {
      if (/^iconBatch:/.test(line)) {
        inBatch = true;
        continue;
      }
      if (inBatch) {
        if (/^\S/.test(line) && !/^(iconBatch:|  |-\s)/.test(line)) {
          inBatch = false;
          if (current) entries.push(current);
          current = null;
          continue;
        }
        const idMatch = line.match(/^\s+-\s+id:\s*(.+)/);
        if (idMatch) {
          if (current) entries.push(current);
          current = { id: idMatch[1].trim(), concept: '' };
          continue;
        }
        const conceptMatch = line.match(/^\s+concept:\s*["']?(.+?)["']?\s*$/);
        if (conceptMatch && current) {
          current.concept = conceptMatch[1].trim();
          continue;
        }
        const descMatch = line.match(/^\s+description:\s*["']?(.+?)["']?\s*$/);
        if (descMatch && current) {
          current.description = descMatch[1].trim();
        }
      }
    }
    if (current) entries.push(current);
    return entries;
  }

  return {
    /**
     * List all batches with their approval/rejection status.
     * Checks both the local worktree shards AND the assets/queue remote branch.
     * @returns {Promise<BatchSummary[]>}
     */
    async listBatches() {
      const [localApproved, queueApproved] = await Promise.all([
        Promise.resolve(loadLocalApprovedIds()),
        getQueueApprovedIds(),
      ]);
      const allApproved = new Map([...localApproved, ...queueApproved]);
      const rejectedSet = new Set(loadRejections().map((r) => r.iconId));
      const briefPaths = collectBriefPaths();
      const batches = [];
      for (const briefPath of briefPaths) {
        const briefId = path.basename(briefPath, '.yaml');
        const category = path.relative(BRIEFS_DIR, path.dirname(briefPath)).replace(/\\/g, '/');
        let entries = [];
        try {
          entries = readIconBatch(briefPath);
        } catch (err) {
          log(`bridge: could not parse ${briefPath}: ${err.message}`);
        }
        const approvedEntries = entries.filter(
          (e) => allApproved.has(e.id) && !rejectedSet.has(e.id),
        );
        batches.push({
          briefId,
          category,
          briefPath: path.relative(repoRoot, briefPath),
          total: entries.length,
          approved: approvedEntries.length,
          entries: entries.map((e) => ({
            ...e,
            isApproved: allApproved.has(e.id),
            isRejected: rejectedSet.has(e.id),
          })),
        });
      }
      return batches;
    },

    /**
     * List recent workflow runs for icon-batch.yml (all statuses, with conclusion).
     * @returns {Promise<{ databaseId: number, status: string, conclusion: string|null, displayTitle: string, createdAt: string }[]>}
     */
    async listRecentRuns() {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          [
            'run',
            'list',
            '--workflow',
            'icon-batch.yml',
            '--limit',
            '8',
            '--json',
            'databaseId,status,conclusion,displayTitle,createdAt',
          ],
          { cwd: repoRoot, timeout: 15_000 },
        );
        return JSON.parse(stdout || '[]');
      } catch (err) {
        log(`listRecentRuns failed: ${err?.message ?? err}`);
        return [];
      }
    },

    /**
     * Dispatch a GitHub Actions workflow run.
     * @param {'generate-briefs' | 'run' | 'run-all' | 'status'} action
     * @param {string} [batchIds]
     */
    async dispatchWorkflow(action, batchIds) {
      const args = ['workflow', 'run', 'icon-batch.yml', '--field', `action=${action}`];
      if (batchIds) args.push('--field', `batch_ids=${batchIds}`);
      try {
        await execFileAsync('gh', args, { cwd: repoRoot });
      } catch (err) {
        throw new Error(
          `gh workflow dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    /**
     * Read a generated icon PNG as a Buffer.
     * Tries local worktree first, then falls back to origin/assets/queue branch.
     * @param {string} iconId
     * @returns {Promise<Buffer | null>}
     */
    async getIconPng(iconId) {
      // Try local worktree first (fast path)
      const localPath = path.join(GENERATED_DIR, `${iconId}.png`);
      if (existsSync(localPath)) {
        try {
          return readFileSync(localPath);
        } catch {
          /* fall through */
        }
      }
      // Try the queue branch (icons committed by CI runs)
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['show', `origin/assets/queue:public/assets/generated/${iconId}.png`],
          { cwd: repoRoot, encoding: 'buffer', timeout: 10_000 },
        );
        return stdout;
      } catch {
        /* not found or no queue branch */
      }
      return null;
    },

    /**
     * Mark an icon as rejected (writes to briefs/icons/.icon-rejections.json).
     * @param {string} iconId
     * @param {string} [feedback]
     */
    async rejectIcon(iconId, feedback = '') {
      let rejections = loadRejections();
      rejections = rejections.filter((r) => r.iconId !== iconId);
      rejections.push({ iconId, feedback, rejectedAt: new Date().toISOString() });
      writeFileSync(REJECTIONS_FILE, JSON.stringify(rejections, null, 2) + '\n');
      return { ok: true };
    },

    /**
     * Remove a rejection for an icon (un-reject).
     * @param {string} iconId
     */
    async unrejectIcon(iconId) {
      const rejections = loadRejections().filter((r) => r.iconId !== iconId);
      writeFileSync(REJECTIONS_FILE, JSON.stringify(rejections, null, 2) + '\n');
      return { ok: true };
    },
  };
}
