import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const activeSourceRoots = [
  'package.json',
  'AGENTS.md',
  '.github/workflows/ci.yml',
  '.github/extensions',
  '.github/scripts',
  '.github/skills',
  '.github/instructions',
  'scripts',
  'tests',
  'src',
  'docs/agent-os',
  'docs/guides',
  'docs/README.md',
  'docs/knowledge/epics',
  '.specify',
];
const scannedExtensions = new Set(['.json', '.md', '.mjs', '.sh', '.ts', '.yaml', '.yml']);
const allowedRetirementDocs = new Set([
  '.github/skills/review-harness/SKILL.md',
  'docs/agent-os/policies/review-harness-policy.md',
  'scripts/agent/review/review-policy.test.mjs',
]);

const retiredTokens = [
  'pr-review-ledger',
  'review:ledger',
  'review:grade',
  'plan_divergence',
  'independent_grade',
  'review-ledger-lifecycle',
  'docs/knowledge/review-ledgers',
];

function activeSourceFiles(path) {
  const absolute = resolve(repoRoot, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) {
    return scannedExtensions.has(extname(absolute)) ? [path] : [];
  }
  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) return activeSourceFiles(relative(repoRoot, child));
    return scannedExtensions.has(extname(entry.name)) ? [relative(repoRoot, child)] : [];
  });
}

test('retired review artifact system is absent from active sources and wiring', () => {
  const files = activeSourceRoots.flatMap(activeSourceFiles);
  for (const file of files) {
    if (allowedRetirementDocs.has(file)) continue;
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    for (const token of retiredTokens) {
      assert.equal(
        source.includes(token),
        false,
        `${file} still contains retired review-system token "${token}". Remove the stale wiring and rerun npm run test:guards.`,
      );
    }
  }
  assert.equal(
    existsSync(resolve(repoRoot, 'docs/knowledge/review-ledgers')),
    false,
    'docs/knowledge/review-ledgers still exists. Remove the retired artifact directory and rerun npm run test:guards.',
  );
});

test('canonical review policy states the approved tier matrix and PR-native audit trail', () => {
  const policyPath = 'docs/agent-os/policies/review-harness-policy.md';
  const policy = readFileSync(resolve(repoRoot, policyPath), 'utf8');
  const normalizedPolicy = policy.replace(/\s+/g, ' ');
  for (const required of [
    '1–2🍎 | Tests and CI only.',
    '3🍎 | One independent post-diff code review.',
    '4–5🍎 | Two independent post-diff code reviews.',
    'Adversarial design review is required **only when the change is architectural**',
    'GitHub pull-request reviews and review threads are the only audit trail',
    'The first 30 merged PRs governed by this policy form the pilot cohort.',
    '**At least 25% lower median PR cycle time**',
  ]) {
    assert.ok(
      normalizedPolicy.includes(required),
      `${policyPath} is missing required policy text "${required}". Restore the approved policy and rerun npm run test:guards.`,
    );
  }
});
