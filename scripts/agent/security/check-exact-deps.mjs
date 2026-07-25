#!/usr/bin/env node
/**
 * security/check-exact-deps.mjs — Reject any non-exact version specifier in
 * direct dependencies, devDependencies, optionalDependencies, and overrides.
 *
 * "Exact" means a plain three-part semver string (or optionally a pre-release /
 * build-metadata suffix) with no leading range operator:
 *   ✅ "1.2.3"        ✅ "4.1.0"       ✅ "1.0.0-beta.1"
 *   ❌ "^1.2.3"       ❌ "~1.2.3"      ❌ ">=1.0.0"
 *   ❌ "*"            ❌ "latest"       ❌ "1.x"
 *
 * Motivation: Fresh releases can be selected during unrelated lockfile
 * regeneration before Microsoft's mandatory npm proxy completes its seven-day
 * quarantine. `npm ci` then fails with a false 404, blocking local work and
 * open PRs. Exact top-level versions prevent any direct dependency from
 * silently advancing during an unrelated `npm install --package-lock-only`.
 *
 * If a version specifier must intentionally be non-exact (e.g. a workspace
 * alias, a git URL, or a local path), add it to EXACT_VERSION_EXEMPTIONS below
 * with a reason comment. The exemption list is intentionally small.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/**
 * Exemptions for entries where a non-exact specifier is intentionally allowed.
 * Each entry: { field, name, reason }
 *   field: the package.json field (e.g. "dependencies")
 *   name: the package name (e.g. "my-pkg")
 *   reason: short explanation for why an exact pin is not used
 */
const EXACT_VERSION_EXEMPTIONS = [
  // No current exemptions. Add here with a reason when needed.
  // Example:
  //   { field: 'dependencies', name: 'my-workspace-pkg', reason: 'workspace alias — must use workspace:*' },
];

/**
 * Regex for an "exact" npm version string:
 *   - No leading range operator (^, ~, >, <, =, *, x, X)
 *   - At minimum three dot-separated numeric components
 *   - Optionally followed by a pre-release tag and/or build metadata
 */
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

/**
 * Returns true if the given version string is considered an exact pin.
 */
export function isExactVersion(version) {
  if (typeof version !== 'string') return false;
  return EXACT_SEMVER_RE.test(version);
}

/**
 * Returns a list of violations found in the given package.json object.
 * Each violation: { field, name, version, reason }
 *
 * @param {object} pkg - parsed package.json
 * @returns {{ field: string, name: string, version: string }[]}
 */
export function findRangeViolations(pkg) {
  const violations = [];

  const directFields = ['dependencies', 'devDependencies', 'optionalDependencies'];
  for (const field of directFields) {
    const entries = pkg[field];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, version] of Object.entries(entries)) {
      if (isExempt(field, name)) continue;
      if (!isExactVersion(version)) {
        violations.push({ field, name, version });
      }
    }
  }

  // overrides can be a flat map or a nested object (npm's "overrides" format allows
  // both `"qs": "6.15.2"` and `"pkg": { ".": "1.0.0", "dep": "2.0.0" }`).
  if (pkg.overrides && typeof pkg.overrides === 'object') {
    checkOverrides(pkg.overrides, 'overrides', violations);
  }

  return violations;
}

/**
 * Recursively validates overrides entries.
 * Nested overrides values can be either a version string or a nested object.
 */
function checkOverrides(obj, field, violations) {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      if (isExempt(field, key)) continue;
      if (!isExactVersion(value)) {
        violations.push({ field, name: key, version: value });
      }
    } else if (value && typeof value === 'object') {
      // Nested overrides object: recurse
      checkOverrides(value, `${field}/${key}`, violations);
    }
  }
}

function isExempt(field, name) {
  return EXACT_VERSION_EXEMPTIONS.some((e) => e.field === field && e.name === name);
}

/**
 * Resolves the repo root from this file's location.
 * scripts/agent/security/check-exact-deps.mjs → three levels up
 */
function repoRoot() {
  const url = new URL(import.meta.url);
  const filePath = url.pathname;
  const parts = filePath.split('/');
  // Remove last 3 segments: check-exact-deps.mjs, security, agent (plus scripts → 4 up)
  const root = parts.slice(0, parts.length - 4).join('/');
  return root || '/';
}

function main() {
  let pkg;
  try {
    const pkgPath = `${repoRoot()}/package.json`;
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`check-exact-deps: could not read package.json: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const violations = findRangeViolations(pkg);
  if (violations.length === 0) {
    process.stdout.write('check-exact-deps: all direct dependencies use exact versions. ✓\n');
    return;
  }

  for (const { field, name, version } of violations) {
    process.stderr.write(
      `[ERROR] package.json ${field}.${name}: "${version}" is not an exact version.\n` +
        `    ↳ Pin to the exact installed version (e.g. from package-lock.json) and\n` +
        `      update the dependency-upgrades procedure doc before changing.\n`,
    );
  }
  process.stderr.write(
    `\ncheck-exact-deps: ${violations.length} violation(s) found.\n` +
      `See docs/guides/dependency-upgrades.md for the intentional upgrade procedure.\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `check-exact-deps crashed: ${error instanceof Error ? error.stack : error}\n`,
    );
    process.exitCode = 2;
  }
}
