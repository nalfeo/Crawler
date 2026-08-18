#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

// fast-uri (GHSA-v2hh-gcrm-f6hx) is intentionally absent: fast-uri was upgraded
// to 3.1.4 in this repo, which patches the advisory. No exception is needed.
export const AUDIT_EXCEPTIONS = [];

export const TEMP_DEPENDENCY_EXCEPTIONS = [];

const AUDIT_SCRIPT_PATH = 'scripts/agent/security/npm-audit.mjs';

// All exported exception arrays in this file that carry expiresOn fields.
// Adding a new expiresOn-bearing exported array without listing it here will
// cause the fail-closed check in getReasonRestatementViolationsForCurrentBranch
// to error, preventing a silent guard bypass.
export const KNOWN_EXPIRY_ARRAY_NAMES = ['AUDIT_EXCEPTIONS', 'TEMP_DEPENDENCY_EXCEPTIONS'];

// Maps each known array name to its live export for violation comparison.
const LIVE_EXPIRY_ARRAYS = {
  AUDIT_EXCEPTIONS,
  TEMP_DEPENDENCY_EXCEPTIONS,
};

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

export function extractNamedExceptionsFromSource(source, arrayName) {
  const escaped = arrayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`export const ${escaped} = (\\[\\]|\\[[\\s\\S]*?\\n\\]);`));
  if (!match) {
    throw new Error(
      `Could not find ${arrayName} declaration in scripts/agent/security/npm-audit.mjs`,
    );
  }

  const exceptions = Function(`"use strict"; return (${match[1]});`)();
  if (!Array.isArray(exceptions)) {
    throw new Error(`${arrayName} declaration is not an array`);
  }

  return exceptions;
}

// Backward-compatible alias; prefer extractNamedExceptionsFromSource for new callers.
export function extractAuditExceptionsFromSource(source) {
  return extractNamedExceptionsFromSource(source, 'AUDIT_EXCEPTIONS');
}

// Returns the names of exported array constants that contain expiresOn entries
// but are not listed in KNOWN_EXPIRY_ARRAY_NAMES. An empty result means the
// current source is fully covered; a non-empty result is a guard failure.
export function findUnknownExpiryArrays(source) {
  const exportedArrayPattern = /export const (\w+) = (\[\]|\[[\s\S]*?\]);/g;
  const unknown = [];
  let match;
  while ((match = exportedArrayPattern.exec(source)) !== null) {
    const [, name, body] = match;
    if (KNOWN_EXPIRY_ARRAY_NAMES.includes(name)) continue;
    if (body.includes('expiresOn')) {
      unknown.push(name);
    }
  }
  return unknown;
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

  // Fail closed: if the current source has any exported array with expiresOn
  // entries that is not listed in KNOWN_EXPIRY_ARRAY_NAMES, error out rather
  // than silently skipping the guard for that array.
  const currentSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const unknownArrays = findUnknownExpiryArrays(currentSource);
  if (unknownArrays.length > 0) {
    throw new Error(
      `Found expiresOn-bearing exported arrays not listed in KNOWN_EXPIRY_ARRAY_NAMES: ` +
        `${unknownArrays.join(', ')}. Add each to KNOWN_EXPIRY_ARRAY_NAMES so the ` +
        `expiry-extension guard covers it.`,
    );
  }

  const violations = [];
  for (const arrayName of KNOWN_EXPIRY_ARRAY_NAMES) {
    let previousArrayExceptions;
    try {
      previousArrayExceptions = extractNamedExceptionsFromSource(previousSource, arrayName);
    } catch {
      // Array did not exist at the base ref (e.g. newly added in this PR) —
      // no previous value to compare against, so no violations for this array.
      continue;
    }
    const currentArrayExceptions = LIVE_EXPIRY_ARRAYS[arrayName];
    const arrayViolations = findReasonRestatementViolations(
      previousArrayExceptions,
      currentArrayExceptions,
    );
    violations.push(...arrayViolations.map((v) => ({ ...v, arrayName })));
  }
  return violations;
}

function isActive(exception, now) {
  const expiresAt = parseExpiresOnDate(exception);
  return now <= expiresAt;
}

function parseExpiresOnDate(exception) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn)) {
    throw new Error(
      `${exception.packageName} expiresOn must be YYYY-MM-DD (received '${exception.expiresOn}')`,
    );
  }
  const expiresAt = new Date(`${exception.expiresOn}T23:59:59.999Z`);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      `${exception.packageName} expiresOn must parse as a valid date (received '${exception.expiresOn}')`,
    );
  }
  const roundTripped = expiresAt.toISOString().slice(0, 10);
  if (roundTripped !== exception.expiresOn) {
    throw new Error(
      `${exception.packageName} expiresOn '${exception.expiresOn}' is not a real calendar date (normalizes to ${roundTripped})`,
    );
  }
  return expiresAt;
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
    const expiresAt = parseExpiresOnDate(exception);
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
            `${violation.arrayName} extension for "${violation.packageName}" changed expiresOn (${violation.previousExpiresOn} -> ${violation.currentExpiresOn}) without changing reason. Extending an exception requires a restated, current justification.`,
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
