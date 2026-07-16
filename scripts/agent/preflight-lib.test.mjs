import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPlaywrightChromiumRevision,
  isPlaywrightChromiumCached,
  resolveNodeBin,
  formatTimingArtifact,
} from './preflight-lib.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a throw-away temp directory with a minimal playwright-core manifest. */
function withPlaywrightManifest(revision, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-lib-'));
  try {
    const pkgDir = join(dir, 'node_modules', 'playwright-core');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'browsers.json'),
      JSON.stringify({
        browsers: [
          { name: 'chromium', revision, installByDefault: true, browserVersion: '148.0' },
          { name: 'chromium-headless-shell', revision, installByDefault: false },
          { name: 'firefox', revision: '1522', installByDefault: true },
        ],
      }),
    );
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// getPlaywrightChromiumRevision
// ---------------------------------------------------------------------------

test('getPlaywrightChromiumRevision reads revision from browsers.json', () => {
  withPlaywrightManifest('1223', (dir) => {
    assert.equal(getPlaywrightChromiumRevision(dir), '1223');
  });
});

test('getPlaywrightChromiumRevision returns null when manifest is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-lib-'));
  try {
    assert.equal(getPlaywrightChromiumRevision(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getPlaywrightChromiumRevision ignores non-installByDefault chromium entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-lib-'));
  try {
    const pkgDir = join(dir, 'node_modules', 'playwright-core');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'browsers.json'),
      JSON.stringify({
        browsers: [
          // tip-of-tree entry — installByDefault false — should be ignored
          { name: 'chromium', revision: '9999', installByDefault: false },
          { name: 'chromium', revision: '1223', installByDefault: true },
        ],
      }),
    );
    assert.equal(getPlaywrightChromiumRevision(dir), '1223');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isPlaywrightChromiumCached — warm (binary already present)
// ---------------------------------------------------------------------------

test('isPlaywrightChromiumCached returns true when Linux binary exists (warm cache)', () => {
  const cacheDir = '/fake/.cache/ms-playwright';
  const result = isPlaywrightChromiumCached({
    revision: '1223',
    cacheDir,
    _existsSync: (p) => p === `${cacheDir}/chromium-1223/chrome-linux64/chrome`,
  });
  assert.equal(result, true);
});

test('isPlaywrightChromiumCached returns true when Windows binary exists (warm cache)', () => {
  const cacheDir = 'C:/Users/dev/AppData/Local/ms-playwright';
  const result = isPlaywrightChromiumCached({
    revision: '1223',
    cacheDir,
    _existsSync: (p) => p === `${cacheDir}/chromium-1223/chrome-win64/chrome.exe`,
  });
  assert.equal(result, true);
});

test('isPlaywrightChromiumCached returns true when macOS arm64 app exists (warm cache)', () => {
  const cacheDir = '/Users/dev/.cache/ms-playwright';
  const result = isPlaywrightChromiumCached({
    revision: '1223',
    cacheDir,
    _existsSync: (p) => p === `${cacheDir}/chromium-1223/chrome-mac-arm64/Chromium.app`,
  });
  assert.equal(result, true);
});

// ---------------------------------------------------------------------------
// isPlaywrightChromiumCached — cold (binary absent)
// ---------------------------------------------------------------------------

test('isPlaywrightChromiumCached returns false when no binary exists (cold cache)', () => {
  const result = isPlaywrightChromiumCached({
    revision: '1223',
    cacheDir: '/fake/.cache/ms-playwright',
    _existsSync: () => false,
  });
  assert.equal(result, false);
});

test('isPlaywrightChromiumCached returns false for wrong revision', () => {
  const cacheDir = '/fake/.cache/ms-playwright';
  // Only revision 9999 exists; we query for 1223
  const result = isPlaywrightChromiumCached({
    revision: '1223',
    cacheDir,
    _existsSync: (p) => p.includes('chromium-9999'),
  });
  assert.equal(result, false);
});

test('isPlaywrightChromiumCached returns false when revision is empty', () => {
  const result = isPlaywrightChromiumCached({
    revision: '',
    cacheDir: '/fake',
    _existsSync: () => true,
  });
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// resolveNodeBin — node PATH behavior under normal and Git Bash environments
// ---------------------------------------------------------------------------

test('resolveNodeBin returns node path when node is on PATH (normal env)', () => {
  const result = resolveNodeBin({
    _which: (cmd) => (cmd === 'node' ? '/usr/bin/node' : null),
    _existsSync: () => false,
    _realpathSync: (p) => p,
  });
  assert.equal(result, '/usr/bin/node');
});

test('resolveNodeBin finds node as sibling of npm when node is not on PATH (Git Bash)', () => {
  // Simulates Git Bash: 'node' not in PATH, but 'npm' is, and node.exe lives next to npm.cmd
  const result = resolveNodeBin({
    _which: (cmd) => (cmd === 'npm' ? '/c/Program Files/nodejs/npm' : null),
    _existsSync: (p) => p === '/c/Program Files/nodejs/node',
    _realpathSync: (p) => p,
  });
  assert.equal(result, '/c/Program Files/nodejs/node');
});

test('resolveNodeBin finds node.exe sibling when node is not on PATH (Windows Git Bash)', () => {
  const result = resolveNodeBin({
    _which: (cmd) => (cmd === 'npm' ? 'C:/Program Files/nodejs/npm.cmd' : null),
    _existsSync: (p) => p === 'C:/Program Files/nodejs/node.exe',
    _realpathSync: (p) => p,
  });
  assert.equal(result, 'C:/Program Files/nodejs/node.exe');
});

test('resolveNodeBin returns empty string when neither node nor npm is found', () => {
  const result = resolveNodeBin({
    _which: () => null,
    _existsSync: () => false,
    _realpathSync: (p) => p,
  });
  assert.equal(result, '');
});

test('resolveNodeBin returns empty string when npm is found but node sibling is absent', () => {
  const result = resolveNodeBin({
    _which: (cmd) => (cmd === 'npm' ? '/usr/local/bin/npm' : null),
    _existsSync: () => false, // no node sibling
    _realpathSync: (p) => p,
  });
  assert.equal(result, '');
});

test('resolveNodeBin accepts explicit npmBin override', () => {
  const result = resolveNodeBin({
    npmBin: '/opt/custom/npm',
    _which: () => null, // node not on PATH, npm not on PATH either
    _existsSync: (p) => p === '/opt/custom/node',
    _realpathSync: (p) => p,
  });
  assert.equal(result, '/opt/custom/node');
});

// ---------------------------------------------------------------------------
// formatTimingArtifact
// ---------------------------------------------------------------------------

test('formatTimingArtifact produces valid JSON with correct schema', () => {
  const json = formatTimingArtifact([
    { name: 'deps', startS: 0, durationS: 1, skipped: true, note: 'lockfile unchanged' },
    { name: 'playwright', startS: 1, durationS: 0, skipped: true, note: 'already cached' },
    { name: 'typecheck', startS: 1, durationS: 20, skipped: false, note: 'completed' },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema, 'agent-os-preflight-timing/v1');
  assert.equal(parsed.phases.length, 3);
});

test('formatTimingArtifact sets metTarget30s=true when total is within 30s', () => {
  const json = formatTimingArtifact([
    { name: 'deps', startS: 0, durationS: 1, skipped: true, note: '' },
    { name: 'playwright', startS: 1, durationS: 0, skipped: true, note: '' },
    { name: 'typecheck', startS: 1, durationS: 10, skipped: false, note: '' },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.totalS, 11);
  assert.equal(parsed.metTarget30s, true);
});

test('formatTimingArtifact sets metTarget30s=false when total exceeds 30s', () => {
  const json = formatTimingArtifact([
    { name: 'typecheck', startS: 0, durationS: 45, skipped: false, note: '' },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.totalS, 45);
  assert.equal(parsed.metTarget30s, false);
});

test('formatTimingArtifact includes timestamp and warmCache fields', () => {
  const ts = '2026-07-16T06:22:45Z';
  const json = formatTimingArtifact([], { timestamp: ts, warmCache: false });
  const parsed = JSON.parse(json);
  assert.equal(parsed.timestamp, ts);
  assert.equal(parsed.warmCache, false);
});
