/**
 * bridge.mjs — icon-batch-review canvas state reader + workflow dispatcher.
 *
 * Reads:
 *  - `briefs/icons/**\/*.yaml` to enumerate known batches and their icon ids
 *  - `public/assets/generated/entries/*.json` shards to find approved icons
 *  - `public/assets/generated/<iconId>.png` to serve icon previews
 *
 * Dispatches:
 *  - `gh workflow run icon-batch.yml` for generate/run actions
 *
 * Runs in-process inside the extension host; no network calls, no Azure.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @param {string} repoRoot
 * @param {{ warn?: (msg: string) => void }} [opts]
 * @returns {{ listBatches: () => Promise<BatchSummary[]>, dispatchWorkflow: (action: string, batchIds?: string) => Promise<void>, getIconPng: (iconId: string) => Buffer | null }}
 */
export function createBridge(repoRoot, opts = {}) {
  const log = opts.warn ?? (() => {});
  const BRIEFS_DIR = path.join(repoRoot, 'briefs', 'icons');
  const SHARDS_DIR = path.join(repoRoot, 'public', 'assets', 'generated', 'entries');
  const GENERATED_DIR = path.join(repoRoot, 'public', 'assets', 'generated');

  /** @returns {Map<string, boolean>} approved icon ids */
  function loadApprovedIds() {
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
     * List all batches with their approval status.
     * @returns {Promise<BatchSummary[]>}
     */
    async listBatches() {
      const approved = loadApprovedIds();
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
        const approvedEntries = entries.filter((e) => approved.has(e.id));
        batches.push({
          briefId,
          category,
          briefPath: path.relative(repoRoot, briefPath),
          total: entries.length,
          approved: approvedEntries.length,
          entries: entries.map((e) => ({
            ...e,
            isApproved: approved.has(e.id),
          })),
        });
      }
      return batches;
    },

    /**
     * List active (queued / in-progress) workflow runs for icon-batch.yml.
     * @returns {Promise<{ databaseId: number, status: string, displayTitle: string, createdAt: string }[]>}
     */
    async listActiveRuns() {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          [
            'run',
            'list',
            '--workflow',
            'icon-batch.yml',
            '--limit',
            '10',
            '--json',
            'databaseId,status,displayTitle,createdAt',
          ],
          { cwd: repoRoot },
        );
        const all = JSON.parse(stdout || '[]');
        return all.filter((r) => ['in_progress', 'queued', 'waiting'].includes(r.status));
      } catch (err) {
        log(`listActiveRuns failed: ${err?.message ?? err}`);
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
     * Read a generated icon PNG as a Buffer (null if not found).
     * @param {string} iconId
     * @returns {Buffer | null}
     */
    getIconPng(iconId) {
      const pngPath = path.join(GENERATED_DIR, `${iconId}.png`);
      if (!existsSync(pngPath)) return null;
      try {
        return readFileSync(pngPath);
      } catch {
        return null;
      }
    },
  };
}
