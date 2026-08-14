#!/usr/bin/env node
/**
 * Validate that lockfile changes are intentional and that newly selected
 * package versions have cleared the registry proxy quarantine.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

export const DEFAULT_QUARANTINE_DAYS = 7;

function resolveBaseRef() {
  const configured = process.env.BASE_SHA;
  if (configured && !/^0+$/.test(configured)) return configured;
  return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
    encoding: 'utf8',
  }).trim();
}

function packageNameFromPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index < 0 ? null : path.slice(index + marker.length);
}

function hasTrustedResolution(entry) {
  return (
    typeof entry.resolved === 'string' &&
    new URL(entry.resolved).hostname === 'registry.npmjs.org' &&
    typeof entry.integrity === 'string' &&
    entry.integrity.startsWith('sha512-')
  );
}

export function findLockfileDrift(changedFiles) {
  const files = new Set(changedFiles);
  return files.has('package-lock.json') && !files.has('package.json');
}

export function findChangedPackages(baseLock, currentLock) {
  const base = baseLock?.packages || {};
  const current = currentLock?.packages || {};
  const changed = [];

  for (const [path, entry] of Object.entries(current)) {
    const name = packageNameFromPath(path);
    if (!name || !entry || typeof entry !== 'object' || !entry.version) continue;
    const previous = base[path];
    if (
      !previous ||
      previous.version !== entry.version ||
      previous.resolved !== entry.resolved ||
      previous.integrity !== entry.integrity
    ) {
      changed.push({
        name,
        version: entry.version,
        path,
        resolved: entry.resolved,
        integrity: entry.integrity,
      });
    }
  }

  return changed;
}

export function findFreshnessViolations(
  packages,
  publishTimes,
  { now = new Date(), quarantineDays = DEFAULT_QUARANTINE_DAYS } = {},
) {
  const cutoff = now.getTime() - quarantineDays * 24 * 60 * 60 * 1000;
  const violations = [];

  for (const entry of packages) {
    if (!hasTrustedResolution(entry)) {
      violations.push({
        ...entry,
        reason: 'lockfile resolution is not a canonical registry.npmjs.org sha512 entry',
      });
      continue;
    }
    const metadata = publishTimes[`${entry.name}@${entry.version}`];
    const publishedAt = typeof metadata === 'string' ? metadata : metadata?.publishedAt;
    if (!publishedAt) {
      violations.push({ ...entry, reason: 'publish time unavailable' });
      continue;
    }
    if (
      typeof metadata !== 'string' &&
      (metadata.resolved !== entry.resolved || metadata.integrity !== entry.integrity)
    ) {
      violations.push({
        ...entry,
        reason: 'lockfile tarball or integrity does not match canonical registry metadata',
      });
      continue;
    }
    const publishedTime = Date.parse(publishedAt);
    if (!Number.isFinite(publishedTime)) {
      violations.push({ ...entry, reason: `invalid publish time "${publishedAt}"` });
      continue;
    }
    if (publishedTime > cutoff) {
      violations.push({
        ...entry,
        publishedAt,
        eligibleAt: new Date(publishedTime + quarantineDays * 24 * 60 * 60 * 1000),
        reason: 'version is inside the registry proxy quarantine window',
      });
    }
  }

  return violations;
}

function repoRoot() {
  return new URL('../../../', import.meta.url);
}

function readBaseLockfile() {
  return JSON.parse(
    execFileSync('git', ['show', `${resolveBaseRef()}:package-lock.json`], { encoding: 'utf8' }),
  );
}

async function fetchPublishTimes(packages) {
  const result = {};
  const registry =
    process.env.npm_config_registry ||
    execFileSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' }).trim();
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    let response;
    try {
      response = await globalThis.fetch(
        `${registry.replace(/\/+$/, '')}/${encodeURIComponent(entry.name)}`,
        {
          headers: { accept: 'application/json' },
        },
      );
    } catch {
      result[key] = null;
      continue;
    }
    if (!response.ok) {
      result[key] = null;
      continue;
    }
    const metadata = await response.json();
    const versionMetadata = metadata.versions?.[entry.version];
    result[key] = {
      publishedAt: metadata.time?.[entry.version] || null,
      resolved: versionMetadata?.dist?.tarball || null,
      integrity: versionMetadata?.dist?.integrity || null,
    };
  }
  return result;
}

async function main() {
  const baseRef = resolveBaseRef();
  const changedFiles = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  if (findLockfileDrift(changedFiles)) {
    throw new Error(
      'package-lock.json changed without package.json. Regenerate the lockfile only as part of an intentional dependency change.',
    );
  }

  const current = JSON.parse(readFileSync(new URL('package-lock.json', repoRoot()), 'utf8'));
  const base = readBaseLockfile();
  const changedPackages = findChangedPackages(base, current);
  if (changedPackages.length === 0) {
    process.stdout.write('check-lock-integrity: no changed package resolutions.\n');
    return;
  }

  const violations = findFreshnessViolations(
    changedPackages,
    await fetchPublishTimes(changedPackages),
  );
  if (violations.length > 0) {
    for (const violation of violations) {
      const eligible = violation.eligibleAt
        ? ` eligible ${violation.eligibleAt.toISOString()}`
        : '';
      process.stderr.write(
        `[ERROR] ${violation.name}@${violation.version}: ${violation.reason}.${eligible}\n`,
      );
    }
    throw new Error(
      `${violations.length} lockfile package resolution(s) cannot be proven safe for the registry proxy.`,
    );
  }

  process.stdout.write(
    `check-lock-integrity: ${changedPackages.length} changed package resolution(s) cleared quarantine.\n`,
  );
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`check-lock-integrity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
