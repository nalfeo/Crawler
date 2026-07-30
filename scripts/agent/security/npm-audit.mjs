#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

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

function parseAuditLevel(args) {
  const prefixed = args.find((arg) => arg.startsWith('--audit-level='));
  if (prefixed) return prefixed.slice('--audit-level='.length);
  const index = args.indexOf('--audit-level');
  return index >= 0 ? args[index + 1] : 'high';
}

function main() {
  const auditLevel = parseAuditLevel(process.argv.slice(2));
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
