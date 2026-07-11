#!/usr/bin/env node
/**
 * Bot commit guard: validates and optionally auto-fixes conventional commit headers.
 *
 * Modes:
 *   --fix-msg <file>   Read commit message from file, fix in-place if fixable,
 *                      exit 1 with diagnostics if not.  Used by the commit-msg hook.
 *   --check-push       Read push ref-pairs from stdin, check all commits in each
 *                      range for header violations.  Used by the pre-push hook.
 *
 * Rules enforced (mirrors commitlint.config.cjs):
 *   - header-max-length: 120
 *   - type-enum: feat|fix|chore|docs|lab|refactor|test|perf|ci|build|revert
 *
 * Auto-fix (--fix-msg only):
 *   - Overlong header with valid type → truncate description at word boundary, append '…'
 *   - Invalid type or missing conventional prefix → exit 1 with actionable message
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// --- Constants (must stay in sync with commitlint.config.cjs) ---

export const MAX_HEADER_LEN = 120;

export const VALID_TYPES = [
  'feat',
  'fix',
  'chore',
  'docs',
  'lab',
  'refactor',
  'test',
  'perf',
  'ci',
  'build',
  'revert',
];

// --- Ignore rules (mirrors commitlint.config.cjs ignores) ---

/**
 * Returns true if the message is exempt from conventional-commit validation.
 *
 * These rules are intentionally a 1-to-1 mirror of the `ignores` array in
 * commitlint.config.cjs.  The two exact-string rules below are scoped to
 * specific historical commits that cannot be rewritten (no force-push policy)
 * — keep them here so the pre-push safety-net never falsely rejects commits
 * that commitlint itself would pass.  Do NOT add new exact-string ignores here
 * without also adding the same rule to commitlint.config.cjs.
 */
export function isIgnored(message) {
  const subject = (message || '').split('\n')[0];
  return (
    subject.toLowerCase().startsWith('merge:') ||
    subject.startsWith('Apply remaining changes') ||
    subject.startsWith('Changes before error encountered') ||
    /^.+\s+\(#\d+\)$/.test(subject) ||
    // Historical exact-match exceptions — see commitlint.config.cjs ignores for rationale.
    subject.startsWith('refine: improve warning details and test clarity') ||
    subject.startsWith('Merge rebased commits (keep local rebase history)')
  );
}

// --- Header parsing ---

// Matches any lowercase-word-prefixed conventional commit header (type may be invalid)
const LOOSE_HEADER_RE = /^([a-z][a-z0-9-]*)(\([^)]*\))?(!)?: (.+)/;

/**
 * Parse a conventional commit header into its components.
 * Returns null if the header doesn't match the conventional format at all.
 */
export function parseHeader(header) {
  const m = (header || '').match(LOOSE_HEADER_RE);
  if (!m) return null;
  return {
    type: m[1],
    scope: m[2] || '',
    breaking: m[3] || '',
    description: m[4],
    prefix: `${m[1]}${m[2] || ''}${m[3] || ''}: `,
  };
}

/**
 * Truncate an overlong header to MAX_HEADER_LEN chars.
 * Tries to find a word boundary in the description; falls back to a hard cut.
 * Always returns a string no longer than MAX_HEADER_LEN.
 */
export function truncateHeader(header) {
  const parsed = parseHeader(header);

  // No conventional prefix — truncate hard
  if (!parsed) {
    return header.slice(0, MAX_HEADER_LEN - 1) + '…';
  }

  const prefixLen = parsed.prefix.length;
  // Budget for description text: reserve 1 char for the ellipsis
  const maxDescLen = MAX_HEADER_LEN - 1 - prefixLen;

  if (maxDescLen < 10) {
    // Extreme edge case: prefix alone is almost at the limit
    return header.slice(0, MAX_HEADER_LEN - 1) + '…';
  }

  const desc = parsed.description;
  if (desc.length <= maxDescLen) return header; // Already fits (caller should have checked)

  // Prefer the last word boundary within the budget (but not too far back)
  let cutAt = maxDescLen;
  const spaceIdx = desc.lastIndexOf(' ', maxDescLen);
  if (spaceIdx > Math.floor(maxDescLen * 0.5)) {
    cutAt = spaceIdx;
  }

  return `${parsed.prefix}${desc.slice(0, cutAt).trimEnd()}…`;
}

/**
 * Validate a single commit subject line.
 *
 * Returns:
 *   { ok: true }                       — valid (or ignored)
 *   { ok: false, fixable: true,  fixed, error, suggestion }  — fixable (overlong)
 *   { ok: false, fixable: false, error, suggestion }          — not fixable (bad type)
 */
export function validateHeader(header) {
  if (!header || !header.trim()) return { ok: true };
  if (isIgnored(header)) return { ok: true, ignored: true };

  const parsed = parseHeader(header);

  if (!parsed) {
    return {
      ok: false,
      fixable: false,
      error: 'does not follow conventional commit format (<type>[optional scope]: <description>)',
      suggestion: `Use format: <type>[optional scope]: <description>\n  Allowed types: ${VALID_TYPES.join(', ')}`,
    };
  }

  if (!VALID_TYPES.includes(parsed.type)) {
    return {
      ok: false,
      fixable: false,
      error: `invalid commit type "${parsed.type}"`,
      suggestion: `Change "${parsed.type}:" to one of: ${VALID_TYPES.join(', ')}`,
    };
  }

  if (header.length > MAX_HEADER_LEN) {
    const fixed = truncateHeader(header);
    return {
      ok: false,
      fixable: true,
      fixed,
      error: `header is ${header.length} chars (max ${MAX_HEADER_LEN})`,
      suggestion: `Truncate to: "${fixed}"`,
    };
  }

  return { ok: true };
}

// --- --fix-msg mode (commit-msg hook) ---

/**
 * Read the commit message file, validate the header, auto-fix if possible, and
 * write back.  Exits the process with 0 (ok/fixed) or 1 (unfixable violation).
 */
export function fixMsgFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    process.stderr.write(`[bot-commit-guard] Could not read "${filePath}": ${e.message}\n`);
    process.exit(1);
  }

  // Extract the first non-empty, non-comment line as the header
  const firstLine = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));

  if (!firstLine) {
    // Empty or comment-only message — let git handle it
    process.exit(0);
  }

  const header = firstLine.trim();
  const result = validateHeader(header);

  if (result.ok) {
    process.exit(0);
  }

  if (result.fixable) {
    // Replace the first occurrence of the original header in the file
    const fixedRaw = raw.replace(firstLine, firstLine.replace(header, result.fixed));
    writeFileSync(filePath, fixedRaw, 'utf-8');
    process.stderr.write(
      `[bot-commit-guard] ✂ Auto-fixed overlong header (${header.length} → ${result.fixed.length} chars):\n` +
        `  Before: "${header}"\n` +
        `  After:  "${result.fixed}"\n`,
    );
    process.exit(0);
  }

  // Not fixable — emit actionable diagnostics and block the commit
  process.stderr.write(
    `❌ bot-commit-guard: commit header rejected\n` +
      `   Header: "${header}"\n` +
      `   Error:  ${result.error}\n` +
      `   Fix:    ${result.suggestion}\n`,
  );
  process.exit(1);
}

// --- --check-push mode (pre-push hook) ---

function gitLog(base, head) {
  try {
    return execFileSync('git', ['log', '--format=%H %s', `${base}..${head}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function mergeBaseWith(sha, ref) {
  try {
    return execFileSync('git', ['merge-base', sha, ref], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function collectViolationsForRange(localSha, remoteSha, violations) {
  const NULL_SHA = '0000000000000000000000000000000000000000';
  if (localSha === NULL_SHA) return; // Delete operation

  let base = remoteSha === NULL_SHA ? null : remoteSha;

  if (!base) {
    // New branch — try to find a merge-base with the upstream default branch
    base =
      mergeBaseWith(localSha, 'origin/main') || mergeBaseWith(localSha, 'origin/master') || null;
  }

  if (!base) return; // Can't determine range — skip

  const log = gitLog(base, localSha);
  if (!log) return;

  for (const line of log.split('\n').filter(Boolean)) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const sha = line.slice(0, spaceIdx);
    const header = line.slice(spaceIdx + 1);

    const result = validateHeader(header);
    if (!result.ok) {
      violations.push({ sha: sha.slice(0, 8), header, result });
    }
  }
}

/**
 * Parse pre-push stdin and return an array of violation objects.
 * Pure function — no git calls; split out for testability.
 * Actual range inspection is deferred to collectViolationsForRange (side-effectful).
 */
export function checkPush(input) {
  const violations = [];

  for (const line of (input || '').trim().split('\n').filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    // Format from git: <local-ref> <local-sha> <remote-ref> <remote-sha>
    const localSha = parts[1];
    const remoteSha = parts[3];
    collectViolationsForRange(localSha, remoteSha, violations);
  }

  return violations;
}

function reportViolations(violations) {
  process.stderr.write(
    `❌ bot-commit-guard: ${violations.length} commit(s) have invalid headers\n\n`,
  );
  for (const { sha, header, result } of violations) {
    process.stderr.write(`  Commit ${sha}: "${header}"\n`);
    process.stderr.write(`  Error:  ${result.error}\n`);
    process.stderr.write(`  Fix:    ${result.suggestion}\n`);
    process.stderr.write('\n');
  }
  process.stderr.write(
    `Tip: The commit-msg hook (installed via \`npm install\`) auto-fixes overlong headers at commit time.\n`,
  );
}

// --- CLI entry point ---

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--fix-msg') {
    if (!args[1]) {
      process.stderr.write('Usage: bot-commit-guard.mjs --fix-msg <commit-msg-file>\n');
      process.exit(1);
    }
    fixMsgFile(args[1]);
  } else if (args[0] === '--check-push') {
    let input = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) input += chunk;

    const violations = checkPush(input);
    if (violations.length > 0) {
      reportViolations(violations);
      process.exit(1);
    }
  } else {
    process.stderr.write(
      'Bot commit guard: validates and auto-fixes conventional commit headers\n\n' +
        'Usage:\n' +
        '  bot-commit-guard.mjs --fix-msg <commit-msg-file>  (commit-msg hook mode)\n' +
        '  bot-commit-guard.mjs --check-push                 (pre-push hook mode, reads stdin)\n',
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
