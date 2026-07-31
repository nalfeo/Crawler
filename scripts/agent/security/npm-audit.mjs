#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

// fast-uri (GHSA-v2hh-gcrm-f6hx) is intentionally absent: fast-uri was upgraded
// to 3.1.4 in this repo, which patches the advisory. No exception is needed.
export const AUDIT_EXCEPTIONS = [
  {
    packageName: 'brace-expansion',
    source: 1124334,
    url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
    expiresOn: '2026-08-13',
    reason:
      'brace-expansion@5.0.8 is patched upstream; Microsoft npm proxy (ms-feed-12.pkgs.visualstudio.com) does not yet mirror it (re-verified 2026-07-30).',
  },
];

export const TEMP_DEPENDENCY_EXCEPTIONS = [
  {
    packageName: 'postcss',
    field: 'overrides',
    version: '8.5.22',
    expiresOn: '2026-08-06',
    reason:
      'Emergency rollback: Microsoft npm proxy does not mirror postcss@8.5.25 yet; keep 8.5.22 only as a short-lived unblock.',
  },
];

const AUDIT_SCRIPT_PATH = 'scripts/agent/security/npm-audit.mjs';

export function findReasonRestatementViolations(previousExceptions, currentExceptions) {
  const previousByPackage = new Map(
    previousExceptions.map((exception) => [exception.packageName, exception]),
  );
  const currentByPackage = new Map(
    currentExceptions.map((exception) => [exception.packageName, exception]),
  );
  const violations = [];

  for (const [packageName, current] of currentByPackage.entries()) {
    const previous = previousByPackage.get(packageName);
    if (!previous) continue;
    if (previous.expiresOn !== current.expiresOn && previous.reason === current.reason) {
      violations.push({
        packageName,
        previousExpiresOn: previous.expiresOn,
        currentExpiresOn: current.expiresOn,
      });
    }
  }

  return violations;
}

export function extractAuditExceptionsFromSource(source) {
  const match = source.match(/export const AUDIT_EXCEPTIONS = (\[\]|\[[\s\S]*?\n\]);/);
  if (!match) {
    throw new Error(
      'Could not find AUDIT_EXCEPTIONS declaration in scripts/agent/security/npm-audit.mjs',
    );
  }

  const exceptions = Function(`"use strict"; return (${match[1]});`)();
  if (!Array.isArray(exceptions)) {
    throw new Error('AUDIT_EXCEPTIONS declaration is not an array');
  }

  return exceptions;
}

function readFileAtRef(ref, relativePath) {
  const result = spawnSync('git', ['show', `${ref}:${relativePath}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function resolveBaseRef() {
  if (process.env.GITHUB_BASE_SHA) return process.env.GITHUB_BASE_SHA;

  for (const candidate of ['origin/main', 'main']) {
    const mergeBaseResult = spawnSync('git', ['merge-base', 'HEAD', candidate], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (mergeBaseResult.status === 0) {
      return mergeBaseResult.stdout.trim();
    }
  }

  return null;
}

export function getReasonRestatementViolationsForCurrentBranch() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    if (process.env.GITHUB_BASE_SHA) {
      // GITHUB_BASE_SHA was explicitly provided (PR context) but could not be
      // resolved — fail closed so a shallow checkout cannot silently bypass the guard.
      throw new Error(
        'GITHUB_BASE_SHA is set but the base ref could not be resolved. ' +
          'Ensure the repository checkout includes the base commit (fetch-depth: 0).',
      );
    }
    // No base ref available and not in explicit PR context — skip comparison
    // (e.g. direct push to main, standalone local audit without origin/main).
    return [];
  }

  const previousSource = readFileAtRef(baseRef, AUDIT_SCRIPT_PATH);
  if (previousSource === null) {
    if (process.env.GITHUB_BASE_SHA) {
      throw new Error(
        `Could not read ${AUDIT_SCRIPT_PATH} at base ref ${baseRef}. ` +
          'Ensure the repository checkout includes the base commit (fetch-depth: 0).',
      );
    }
    return [];
  }

  const previousExceptions = extractAuditExceptionsFromSource(previousSource);
  return findReasonRestatementViolations(previousExceptions, AUDIT_EXCEPTIONS);
}

function isActive(exception, now) {
  const expiresAt = new Date(`${exception.expiresOn}T23:59:59.999Z`);
  return now <= expiresAt;
}

function matchesException(packageName, advisory, exception, now) {
  return (
    isActive(exception, now) &&
    packageName === exception.packageName &&
    advisory.source === exception.source &&
    advisory.url === exception.url
  );
}

function isAtOrAbove(severity, threshold) {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

export function evaluateAudit(
  report,
  { auditLevel = 'high', now = new Date(), exceptions = AUDIT_EXCEPTIONS } = {},
) {
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object') {
    throw new Error('Unsupported or invalid npm audit JSON report');
  }
  if (!SEVERITY_ORDER.includes(auditLevel)) {
    throw new Error(`Unsupported audit level: ${auditLevel}`);
  }

  const ignored = new Set();
  const matchedExceptionKeys = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
      if (ignored.has(packageName) || !Array.isArray(vulnerability.via)) continue;
      const solelyExcepted =
        vulnerability.via.length > 0 &&
        vulnerability.via.every((via) => {
          if (typeof via === 'string') return ignored.has(via);
          const exception = exceptions.find((candidate) =>
            matchesException(packageName, via, candidate, now),
          );
          if (exception) {
            matchedExceptionKeys.add(exception.url);
            return true;
          }
          return false;
        });
      if (solelyExcepted) {
        ignored.add(packageName);
        changed = true;
      }
    }
  }

  const blocking = Object.values(report.vulnerabilities).filter((vulnerability) => {
    // Fail closed: treat null, array, or unknown severity as blocking so malformed
    // entries never silently pass through the audit gate.
    if (!SEVERITY_ORDER.includes(vulnerability.severity)) return true;
    if (ignored.has(vulnerability.name)) return false;
    return isAtOrAbove(vulnerability.severity, auditLevel);
  });
  const matchedExceptions = exceptions.filter((exception) =>
    matchedExceptionKeys.has(exception.url),
  );
  return { blocking, ignored: [...ignored].sort(), matchedExceptions };
}

export function evaluateTemporaryDependencyExceptions(
  packageManifest,
  { now = new Date(), exceptions = TEMP_DEPENDENCY_EXCEPTIONS } = {},
) {
  const active = [];
  const expired = [];
  for (const exception of exceptions) {
    const fieldValue = packageManifest?.[exception.field];
    const pinnedVersion =
      fieldValue && typeof fieldValue === 'object' ? fieldValue[exception.packageName] : undefined;
    if (pinnedVersion !== exception.version) continue;
    const expiresAt = new Date(`${exception.expiresOn}T23:59:59.999Z`);
    if (now > expiresAt) {
      expired.push(exception);
    } else {
      active.push(exception);
    }
  }

  return { active, expired };
}

function readPackageManifest() {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseAuditLevel(args) {
  const prefixed = args.find((arg) => arg.startsWith('--audit-level='));
  if (prefixed) return prefixed.slice('--audit-level='.length);
  const index = args.indexOf('--audit-level');
  return index >= 0 ? args[index + 1] : 'high';
}

function main() {
  const reasonViolations = getReasonRestatementViolationsForCurrentBranch();
  if (reasonViolations.length > 0) {
    process.stderr.write(
      `${reasonViolations
        .map(
          (violation) =>
            `AUDIT_EXCEPTIONS extension for "${violation.packageName}" changed expiresOn (${violation.previousExpiresOn} -> ${violation.currentExpiresOn}) without changing reason. Extending an exception requires a restated, current justification.`,
        )
        .join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const auditLevel = parseAuditLevel(process.argv.slice(2));
  const packageManifest = readPackageManifest();
  if (packageManifest) {
    const { active, expired } = evaluateTemporaryDependencyExceptions(packageManifest);
    if (active.length > 0) {
      process.stderr.write(
        `${active
          .map(
            (exception) =>
              `Temporary dependency exception through ${exception.expiresOn}: ${exception.packageName}@${exception.version} (${exception.reason})`,
          )
          .join('\n')}\n`,
      );
    }
    if (expired.length > 0) {
      process.stderr.write(
        `${expired
          .map(
            (exception) =>
              `Dependency exception expired for ${exception.packageName}@${exception.version} on ${exception.expiresOn}. Upgrade to a mirrored newer version and remove the exception.`,
          )
          .join('\n')}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : 'npm';
  const args = npmCli ? [npmCli, 'audit', '--json'] : ['audit', '--json'];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: !npmCli && process.platform === 'win32',
  });
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr);
    throw new Error(`npm audit did not return valid JSON (exit ${result.status ?? 'unknown'})`);
  }
  if (report.error) {
    throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  }

  const { blocking, ignored, matchedExceptions } = evaluateAudit(report, { auditLevel });
  if (ignored.length > 0 && matchedExceptions.length > 0) {
    process.stderr.write(
      `${matchedExceptions
        .map(
          (exception) =>
            `Temporary audit exception through ${exception.expiresOn}: ${exception.url}`,
        )
        .join('\n')}\n` + `Suppressed derived findings: ${ignored.join(', ')}\n`,
    );
  }
  if (blocking.length > 0) {
    process.stderr.write(
      `npm audit found ${blocking.length} blocking ${auditLevel}+ finding(s): ` +
        `${blocking.map((item) => item.name).join(', ')}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 2;
  }
}
