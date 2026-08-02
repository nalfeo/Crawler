#!/usr/bin/env node
/**
 * check-asset-integrity.ts — CI guard that the recorded `contentHash` of every
 * approved generated-art shard actually matches the bytes of the PNG it points
 * at, and that every shard's declared identity matches the file it names.
 *
 * Walks `public/assets/generated/entries/**\/*.json` (the source of truth —
 * `manifest.json` is a gitignored build artifact and is deliberately NOT read),
 * resolves each `assetPath` under `public/assets/`, hashes the PNG once with
 * SHA-256, and hands the records to the pure checker in
 * `asset-integrity-lib.ts`.
 *
 * Exits non-zero when any shard has:
 *   - a `contentHash` that disagrees with the PNG's bytes (stale hash / wrong art)
 *   - an `assetPath` pointing at a file that does not exist (orphan shard)
 *   - an `assetPath` whose identity does not match `spriteName` (wrong sprite renders)
 *   - a `spriteName` or `assetPath` shared with another shard
 *   - malformed JSON or a missing required field
 *
 * Shards with no `contentHash` (approved before hashing existed) are reported
 * as an informational count and never fail the check.
 *
 * ## Cost
 *
 * This reads and hashes the entire PNG corpus, so it is a CI-only check — it is
 * not wired into `verify:fast`. Each PNG is read exactly once. The corpus size
 * and elapsed wall time are printed on every run so a regression in its own
 * cost is visible.
 *
 * ## Usage
 *
 *   npx tsx scripts/agent/health/check-asset-integrity.ts
 *   npx tsx scripts/agent/health/check-asset-integrity.ts --json
 *
 * `--json` emits a single machine-readable document on stdout (and nothing
 * else) for automation; the exit code is identical in both modes.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  checkAssetIntegrity,
  type Finding,
  type MalformedShard,
  type ShardRecord,
} from './asset-integrity-lib.js';

/** Repo-relative root of the shard corpus. */
const ENTRIES_DIR = 'public/assets/generated/entries';

/** Directory `assetPath` values are resolved against. */
const ASSETS_ROOT = 'public/assets';

const scriptName = 'check-asset-integrity';
const jsonMode = process.argv.includes('--json');

/** Recursively collect `*.json` shard paths, sorted for deterministic output. */
function collectShardFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const relPath = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectShardFiles(path.join(absDir, entry.name), relPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(relPath);
    }
  }
  return out;
}

/** SHA-256 of a file's bytes, or null when the file cannot be read. */
function hashFile(absPath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

/** True when `absPath` exists and is a regular file. */
function isFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

interface CorpusScan {
  readonly records: readonly ShardRecord[];
  readonly malformed: readonly MalformedShard[];
}

/** Read and hash the whole corpus. Never throws on a bad individual shard. */
function scanCorpus(shardFiles: readonly string[]): CorpusScan {
  const records: ShardRecord[] = [];
  const malformed: MalformedShard[] = [];

  for (const shardFile of shardFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fromRepo(shardFile), 'utf8'));
    } catch (e) {
      malformed.push({ shardFile, reason: `invalid JSON — ${(e as Error).message}` });
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      malformed.push({ shardFile, reason: 'expected a JSON object at the top level' });
      continue;
    }

    const shard = parsed as Record<string, unknown>;
    const spriteName = shard['spriteName'];
    const assetPath = shard['assetPath'];

    if (typeof spriteName !== 'string' || spriteName.length === 0) {
      malformed.push({ shardFile, reason: 'missing required string field "spriteName"' });
      continue;
    }
    if (typeof assetPath !== 'string' || assetPath.length === 0) {
      malformed.push({ shardFile, reason: 'missing required string field "assetPath"' });
      continue;
    }

    const rawHash = shard['contentHash'];
    if (rawHash !== undefined && rawHash !== null && typeof rawHash !== 'string') {
      malformed.push({ shardFile, reason: '"contentHash" is present but is not a string' });
      continue;
    }
    const contentHash = typeof rawHash === 'string' ? rawHash : undefined;

    const absAsset = fromRepo(ASSETS_ROOT, assetPath);
    const fileExists = isFile(absAsset);
    // Hash only when we will actually compare — one read per PNG, and none at
    // all for the ~125 legitimately unhashed legacy entries.
    let actualHash: string | undefined;
    if (fileExists && contentHash !== undefined) {
      const hashed = hashFile(absAsset);
      if (hashed === null) {
        // The file exists but could not be read (permissions, truncation, a
        // corrupt object). Collapsing this to `undefined` would make it
        // indistinguishable from "no contentHash declared" and the shard would
        // pass silently — the exact silent-accept shape this guard exists to
        // prevent. Report it instead.
        malformed.push({
          shardFile,
          reason: `declares a contentHash but its asset "${assetPath}" exists and could not be read for hashing`,
        });
        continue;
      }
      actualHash = hashed;
    }

    records.push({ shardFile, spriteName, assetPath, contentHash, actualHash, fileExists });
  }

  return { records, malformed };
}

const startedAt = Date.now();
const entriesAbs = fromRepo(ENTRIES_DIR);

if (!isDirectory(entriesAbs)) {
  emitMissingCorpus();
}

const shardFiles = collectShardFiles(entriesAbs, ENTRIES_DIR);
const { records, malformed } = scanCorpus(shardFiles);
const result = checkAssetIntegrity(records, malformed);
const elapsedMs = Date.now() - startedAt;

if (jsonMode) {
  process.stdout.write(
    `${JSON.stringify(
      {
        script: scriptName,
        ok: result.findings.length === 0,
        elapsedMs,
        shardFiles: shardFiles.length,
        ...result.summary,
        malformed: malformed.length,
        findings: result.findings,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(result.findings.length === 0 ? 0 : 1);
}

const report = new Report(scriptName);

for (const finding of byKind(result.findings)) {
  report.error(`[${finding.kind}] ${finding.detail}`, {
    file: finding.shardFile,
    remediation: finding.remediation,
  });
}

report.info(
  `Corpus: ${shardFiles.length} shard file(s), ${result.summary.shardsChecked} readable, ` +
    `${result.summary.hashesVerified} contentHash value(s) verified against PNG bytes, ` +
    `${result.summary.unhashed} entr(ies) with no contentHash (legacy — not a failure).`,
);
report.info(`Elapsed: ${elapsedMs}ms.`);

report.finish();

/** Group findings by kind so a run reads as one section per failure class. */
function byKind(findings: readonly Finding[]): readonly Finding[] {
  const order: readonly Finding['kind'][] = [
    'malformed',
    'hash-mismatch',
    'name-mismatch',
    'missing-file',
    'duplicate-name',
    'duplicate-path',
  ];
  return [...findings].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** True when `absPath` exists and is a directory. */
function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A missing corpus directory is a configuration failure, not a pass — a guard
 * that silently checks nothing is worse than no guard.
 */
function emitMissingCorpus(): never {
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify(
        {
          script: scriptName,
          ok: false,
          error: `${ENTRIES_DIR} does not exist`,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
  const r = new Report(scriptName);
  r.error(
    `${ENTRIES_DIR} does not exist, so zero shards would be checked. ` +
      'This is a configuration failure, not a clean corpus.',
    {
      file: ENTRIES_DIR,
      remediation: `Run this script from the repo root and confirm ${ENTRIES_DIR} is checked out.`,
    },
  );
  return r.finish();
}
