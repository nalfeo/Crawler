#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

export const AUDIT_EXCEPTIONS = [
  {
    packageName: 'fast-uri',
    source: 1124064,
    url: 'https://github.com/advisories/GHSA-v2hh-gcrm-f6hx',
    expiresOn: '2026-07-29',
    reason: 'Microsoft npm proxy does not yet mirror fixed 3.x release 3.1.4.',
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

export function evaluateAudit(report, { auditLevel = 'high', now = new Date() } = {}) {
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object') {
    throw new Error('Unsupported or invalid npm audit JSON report');
  }
  if (!SEVERITY_ORDER.includes(auditLevel)) {
    throw new Error(`Unsupported audit level: ${auditLevel}`);
  }

  const ignored = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
      if (ignored.has(packageName) || !Array.isArray(vulnerability.via)) continue;
      const solelyExcepted =
        vulnerability.via.length > 0 &&
        vulnerability.via.every((via) => {
          if (typeof via === 'string') return ignored.has(via);
          return AUDIT_EXCEPTIONS.some((exception) =>
            matchesException(packageName, via, exception, now),
          );
        });
      if (solelyExcepted) {
        ignored.add(packageName);
        changed = true;
      }
    }
  }

  const blocking = Object.values(report.vulnerabilities).filter((vulnerability) => {
    if (ignored.has(vulnerability.name)) return false;
    // Fail closed: treat null, array, or unknown severity as blocking so malformed
    // entries never silently pass through the audit gate.
    if (!SEVERITY_ORDER.includes(vulnerability.severity)) return true;
    return isAtOrAbove(vulnerability.severity, auditLevel);
  });
  return { blocking, ignored: [...ignored].sort() };
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

  const { blocking, ignored } = evaluateAudit(report, { auditLevel });
  if (ignored.length > 0) {
    const exception = AUDIT_EXCEPTIONS[0];
    process.stderr.write(
      `Temporary audit exception through ${exception.expiresOn}: ${exception.url}\n` +
        `Suppressed derived findings: ${ignored.join(', ')}\n`,
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
