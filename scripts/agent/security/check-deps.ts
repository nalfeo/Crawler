#!/usr/bin/env node
/**
 * security/check-deps.ts — Diff package.json deps against an allowlist of
 * trusted scopes / publishers and flag anything new that doesn't match.
 *
 * The allowlist is intentionally small. Adding a new dependency from an
 * unlisted source requires either:
 *   (a) extending the allowlist (and explaining why in the same PR), or
 *   (b) adding the exact package to TRUSTED_PACKAGES below.
 *
 * Runs as a blocking check on PRs.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

// Trusted scopes / unscoped first-party Node ecosystem packages.
const TRUSTED_SCOPES = [
  '@types/',
  '@typescript-eslint/',
  '@eslint/',
  '@vitejs/',
  '@vitest/',
  '@fastify/',
  '@stryker-mutator/',
  '@azure/',
];

const TRUSTED_PACKAGES = new Set<string>([
  // Game runtime
  'phaser',
  'bitecs',
  'rot-js',
  'loglevel',
  // Build / dev tooling
  'vite',
  'vitest',
  'typescript',
  'tsx',
  'eslint',
  'typescript-eslint',
  'prettier',
  'knip',
  'globals',
  'fast-check',
  'lil-gui',
  'pngjs',
  'yaml',
  'zod',
  'fastify',
  'playwright',
  'esbuild',
  // Sprite pipeline shared cross-session cache (ADR 0065) — npm/pacote's own
  // content-addressable store. ISC-licensed, maintained by the npm CLI team,
  // widely audited, and used by npm itself. Pinned to the version in
  // package.json; no known CVEs as of 2026-07-20.
  'cacache',
]);

function isTrusted(name: string): boolean {
  if (TRUSTED_PACKAGES.has(name)) return true;
  return TRUSTED_SCOPES.some((scope) => name.startsWith(scope));
}

async function main(): Promise<void> {
  const report = new Report('security-check-deps');
  const pkg = JSON.parse(readFileSync(fromRepo('package.json'), 'utf8')) as PackageJson;
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const [name] of Object.entries(all)) {
    if (!isTrusted(name)) {
      report.error(`Untrusted dependency: ${name}`, {
        file: 'package.json',
        remediation:
          'Confirm publisher + maintenance status, then add to TRUSTED_PACKAGES (or TRUSTED_SCOPES) in scripts/agent/security/check-deps.ts.',
      });
    }
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`check-deps crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
