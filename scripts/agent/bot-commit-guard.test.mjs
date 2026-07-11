import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/* global process */
import {
  MAX_HEADER_LEN,
  VALID_TYPES,
  isIgnored,
  parseHeader,
  truncateHeader,
  validateHeader,
  fixMsgFile,
  checkPush,
} from './bot-commit-guard.mjs';

// ---------------------------------------------------------------------------
// isIgnored
// ---------------------------------------------------------------------------

test('isIgnored: allows merge: commits', () => {
  assert.equal(isIgnored('merge: sync branch'), true);
  assert.equal(isIgnored('Merge: caps variant'), true);
});

test('isIgnored: allows Apply remaining changes', () => {
  assert.equal(isIgnored('Apply remaining changes'), true);
});

test('isIgnored: allows GitHub auto-merge "Title (#123)" format', () => {
  assert.equal(isIgnored('feat: add system (#42)'), true);
  assert.equal(isIgnored('fix: something (#1234)'), true);
});

test('isIgnored: does NOT ignore normal conventional commits', () => {
  assert.equal(isIgnored('feat: add new system'), false);
  assert.equal(isIgnored('fix(core): resolve null pointer'), false);
});

// ---------------------------------------------------------------------------
// parseHeader
// ---------------------------------------------------------------------------

test('parseHeader: parses simple type+description', () => {
  const p = parseHeader('feat: add feature');
  assert.ok(p);
  assert.equal(p.type, 'feat');
  assert.equal(p.scope, '');
  assert.equal(p.breaking, '');
  assert.equal(p.description, 'add feature');
  assert.equal(p.prefix, 'feat: ');
});

test('parseHeader: parses type+scope', () => {
  const p = parseHeader('fix(core): resolve issue');
  assert.ok(p);
  assert.equal(p.type, 'fix');
  assert.equal(p.scope, '(core)');
  assert.equal(p.prefix, 'fix(core): ');
});

test('parseHeader: parses breaking change marker', () => {
  const p = parseHeader('feat(api)!: breaking change');
  assert.ok(p);
  assert.equal(p.type, 'feat');
  assert.equal(p.breaking, '!');
  assert.equal(p.prefix, 'feat(api)!: ');
});

test('parseHeader: returns null for non-conventional header', () => {
  assert.equal(parseHeader('just a plain commit message'), null);
  assert.equal(parseHeader(''), null);
  assert.equal(parseHeader(null), null);
});

// ---------------------------------------------------------------------------
// truncateHeader
// ---------------------------------------------------------------------------

test('truncateHeader: leaves short headers unchanged', () => {
  const h = 'feat: short subject';
  assert.equal(truncateHeader(h), h);
});

test('truncateHeader: truncates to MAX_HEADER_LEN', () => {
  const longDesc = 'a'.repeat(200);
  const header = `feat: ${longDesc}`;
  const result = truncateHeader(header);
  assert.ok(
    result.length <= MAX_HEADER_LEN,
    `length ${result.length} should be <= ${MAX_HEADER_LEN}`,
  );
  assert.ok(result.endsWith('…'));
  assert.ok(result.startsWith('feat: '));
});

test('truncateHeader: prefers word boundary when available', () => {
  // Build a header where there is a convenient word boundary well within budget
  const prefix = 'feat: ';
  // Budget for description = MAX_HEADER_LEN - 1 (ellipsis) - prefix.length
  const budget = MAX_HEADER_LEN - 1 - prefix.length;
  const words = [];
  let len = 0;
  while (len < budget + 20) {
    const word = 'word';
    words.push(word);
    len += word.length + 1;
  }
  const header = prefix + words.join(' ');
  const result = truncateHeader(header);
  assert.ok(result.length <= MAX_HEADER_LEN);
  // Should end with '…' and not cut mid-word
  assert.ok(result.endsWith('…'));
});

test('truncateHeader: handles header without conventional prefix', () => {
  const header = 'x'.repeat(200);
  const result = truncateHeader(header);
  assert.ok(result.length <= MAX_HEADER_LEN);
  assert.ok(result.endsWith('…'));
});

// ---------------------------------------------------------------------------
// validateHeader
// ---------------------------------------------------------------------------

test('validateHeader: ok for valid short headers', () => {
  for (const type of VALID_TYPES) {
    const r = validateHeader(`${type}: something`);
    assert.equal(r.ok, true, `Expected ok for type "${type}"`);
  }
});

test('validateHeader: ok for scoped header', () => {
  const r = validateHeader('feat(game): add system');
  assert.equal(r.ok, true);
});

test('validateHeader: ok for ignored commit', () => {
  const r = validateHeader('Apply remaining changes');
  assert.equal(r.ok, true);
  assert.equal(r.ignored, true);
});

test('validateHeader: fixable=true for overlong header with valid type', () => {
  const header = 'feat: ' + 'a'.repeat(200);
  const r = validateHeader(header);
  assert.equal(r.ok, false);
  assert.equal(r.fixable, true);
  assert.ok(r.fixed);
  assert.ok(r.fixed.length <= MAX_HEADER_LEN);
  assert.ok(r.fixed.endsWith('…'));
});

test('validateHeader: fixable=false for invalid type', () => {
  const r = validateHeader('refine: some message');
  assert.equal(r.ok, false);
  assert.equal(r.fixable, false);
  assert.match(r.error, /invalid commit type/);
  assert.match(r.suggestion, /refactor/); // suggestion should mention allowed types
});

test('validateHeader: fixable=false for non-conventional format', () => {
  const r = validateHeader('just a plain commit message');
  assert.equal(r.ok, false);
  assert.equal(r.fixable, false);
  assert.match(r.error, /conventional commit format/);
});

test('validateHeader: ok for empty header', () => {
  assert.equal(validateHeader('').ok, true);
  assert.equal(validateHeader(null).ok, true);
});

test('validateHeader: ok for header exactly at max length', () => {
  const prefix = 'feat: ';
  const description = 'a'.repeat(MAX_HEADER_LEN - prefix.length);
  const header = prefix + description;
  assert.equal(header.length, MAX_HEADER_LEN);
  const r = validateHeader(header);
  assert.equal(r.ok, true);
});

test('validateHeader: not ok for header one char over max', () => {
  const prefix = 'feat: ';
  const description = 'a'.repeat(MAX_HEADER_LEN - prefix.length + 1);
  const header = prefix + description;
  assert.equal(header.length, MAX_HEADER_LEN + 1);
  const r = validateHeader(header);
  assert.equal(r.ok, false);
  assert.equal(r.fixable, true);
});

// ---------------------------------------------------------------------------
// fixMsgFile
// ---------------------------------------------------------------------------

function withTempMsgFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-commit-guard-'));
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, content, 'utf-8');
  try {
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fixMsgFile: exits 0 for valid short message', () => {
  withTempMsgFile('feat: valid short message\n', (file) => {
    // Intercept process.exit
    const originalExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      fixMsgFile(file);
    } catch {
      // expected: process.exit throws in mock
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exitCode, 0);
  });
});

test('fixMsgFile: auto-fixes overlong header and exits 0', () => {
  const longHeader = 'feat: ' + 'word '.repeat(30).trim(); // well over 120 chars
  withTempMsgFile(longHeader + '\n\nBody text here.\n', (file) => {
    const originalExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      fixMsgFile(file);
    } catch {
      // expected
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exitCode, 0);
    const fixed = readFileSync(file, 'utf-8');
    const fixedHeader = fixed.split('\n')[0];
    assert.ok(
      fixedHeader.length <= MAX_HEADER_LEN,
      `fixed header "${fixedHeader}" length ${fixedHeader.length}`,
    );
    assert.ok(fixedHeader.endsWith('…'));
    // Body must be preserved
    assert.match(fixed, /Body text here/);
  });
});

test('fixMsgFile: exits 1 for invalid commit type', () => {
  withTempMsgFile('refine: some message\n', (file) => {
    const originalExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      fixMsgFile(file);
    } catch {
      // expected
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exitCode, 1);
  });
});

test('fixMsgFile: skips comment lines when finding header', () => {
  const msg = '# This is a comment\nfeat: valid message\n';
  withTempMsgFile(msg, (file) => {
    const originalExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      fixMsgFile(file);
    } catch {
      // expected
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// checkPush (pure parsing — no git calls; violations array stays empty)
// ---------------------------------------------------------------------------

test('checkPush: returns empty array for empty input', () => {
  const violations = checkPush('');
  assert.deepEqual(violations, []);
});

test('checkPush: returns empty array for whitespace-only input', () => {
  assert.deepEqual(checkPush('   \n  \n'), []);
});

test('checkPush: skips delete operations (localSha=0000)', () => {
  const input =
    'refs/heads/my-branch 0000000000000000000000000000000000000000 refs/heads/my-branch abc123\n';
  // No git available in test env for range inspection, but delete op (local=0000) must be skipped
  const violations = checkPush(input);
  assert.deepEqual(violations, []);
});

test('checkPush: ignores lines with fewer than 4 parts', () => {
  const violations = checkPush('refs/heads/foo abc123\n');
  assert.deepEqual(violations, []);
});
