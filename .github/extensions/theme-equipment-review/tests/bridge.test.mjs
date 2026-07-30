import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertPlanOnRef,
  createSerializedThemeEquipmentReviewRunner,
  loadRepoEnv,
  resolveDispatchRef,
  resolveThemeSetId,
  selectThemeEquipmentRun,
  themeEquipmentRunStatus,
} from '../lib/bridge.mjs';

function repoWithSets(setIds) {
  const root = mkdtempSync(path.join(tmpdir(), 'theme-review-sets-'));
  const dir = path.join(root, 'data', 'theme-equipment-sets');
  mkdirSync(dir, { recursive: true });
  for (const setId of setIds) {
    writeFileSync(path.join(dir, `${setId}.json`), `{"id":"${setId}"}\n`);
  }
  return root;
}

test('resolves the only authored set when the canvas is opened without a setId', () => {
  const root = repoWithSets(['classic-fantasy']);
  try {
    assert.equal(resolveThemeSetId(root, undefined), 'classic-fantasy');
    assert.equal(resolveThemeSetId(root, 'pirate'), 'pirate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('opens on the set index instead of failing when zero or several authored sets exist', () => {
  const empty = repoWithSets([]);
  const many = repoWithSets(['classic-fantasy', 'pirate']);
  try {
    assert.equal(resolveThemeSetId(empty, undefined), null);
    assert.equal(resolveThemeSetId(many, undefined), null);
    assert.equal(resolveThemeSetId(many, 'pirate'), 'pirate');
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(many, { recursive: true, force: true });
  }
});

test('loads missing values from .env.local without overriding the process environment', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'theme-review-env-'));
  try {
    writeFileSync(
      path.join(root, '.env.local'),
      'SPRITES_RUN_STORE=azure-blob\nAZURE_STORAGE_ACCOUNT="from-file"\n',
    );
    const env = loadRepoEnv(root, { AZURE_STORAGE_ACCOUNT: 'already-set' });
    assert.equal(env.SPRITES_RUN_STORE, 'azure-blob');
    assert.equal(env.AZURE_STORAGE_ACCOUNT, 'already-set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serializes state mutations per set while allowing different sets to proceed', async () => {
  const started = [];
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const run = createSerializedThemeEquipmentReviewRunner(async (command) => {
    started.push(`${command.setId}:${command.expectedRevision}`);
    if (command.setId === 'classic-fantasy' && command.expectedRevision === 0) await first;
    return command.expectedRevision;
  });

  const firstMutation = run({
    action: 'item-review',
    setId: 'classic-fantasy',
    expectedRevision: 0,
  });
  const secondMutation = run({
    action: 'set-review',
    setId: 'classic-fantasy',
    expectedRevision: 1,
  });
  const otherSetMutation = run({
    action: 'advance',
    setId: 'pirate',
    expectedRevision: 4,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ['classic-fantasy:0', 'pirate:4']);
  releaseFirst();
  assert.deepEqual(await Promise.all([firstMutation, secondMutation, otherSetMutation]), [0, 1, 4]);
  assert.deepEqual(started, ['classic-fantasy:0', 'pirate:4', 'classic-fantasy:1']);
});

test('resolves the dispatch ref from the checked-out branch and rejects detached HEAD', async () => {
  const root = repoWithSets([]);
  const run = (args) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') },
    });
  try {
    writeFileSync(path.join(root, 'gitconfig'), '[user]\n  name = t\n  email = t@example.com\n');
    run(['init', '--quiet', '--initial-branch', 'feature-branch']);
    writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    run(['add', '.']);
    run(['commit', '--quiet', '-m', 'seed']);

    assert.equal(await resolveDispatchRef(root), 'feature-branch');

    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    run(['checkout', '--quiet', sha]);
    await assert.rejects(() => resolveDispatchRef(root), /detached HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to initialize when the remote ref cannot be fetched', async () => {
  const root = repoWithSets(['classic-fantasy']);
  try {
    await assert.rejects(
      () =>
        assertPlanOnRef(root, 'feature-branch', 'data/theme-equipment-sets/classic-fantasy.json'),
      /Could not fetch origin\/feature-branch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns the freshly fetched remote tip sha so the dispatch can pin an immutable commit', async () => {
  const remote = mkdtempSync(path.join(tmpdir(), 'theme-review-remote-sha-'));
  const root = repoWithSets(['classic-fantasy']);
  const planPath = 'data/theme-equipment-sets/classic-fantasy.json';
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  const run = (args, cwd = root) =>
    execFileSync('git', args, { cwd, stdio: 'ignore', env: gitEnv });
  try {
    writeFileSync(path.join(root, 'gitconfig'), '[user]\n  name = t\n  email = t@example.com\n');
    execFileSync('git', ['init', '--quiet', '--bare', remote], { stdio: 'ignore', env: gitEnv });
    run(['init', '--quiet', '--initial-branch', 'feature-branch']);
    run(['remote', 'add', 'origin', remote]);
    run(['add', '.']);
    run(['commit', '--quiet', '-m', 'seed']);
    run(['push', '--quiet', 'origin', 'feature-branch']);

    const sha = await assertPlanOnRef(root, 'feature-branch', planPath, gitEnv);
    const expected = execFileSync('git', ['rev-parse', 'feature-branch'], {
      cwd: root,
      encoding: 'utf8',
      env: gitEnv,
    }).trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sha, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test('judges the plan against the freshly fetched remote tip, not a stale tracking ref', async () => {
  const remote = mkdtempSync(path.join(tmpdir(), 'theme-review-remote-'));
  const root = repoWithSets(['classic-fantasy']);
  const planPath = 'data/theme-equipment-sets/classic-fantasy.json';
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  const run = (args, cwd = root) =>
    execFileSync('git', args, { cwd, stdio: 'ignore', env: gitEnv });
  try {
    writeFileSync(path.join(root, 'gitconfig'), '[user]\n  name = t\n  email = t@example.com\n');
    execFileSync('git', ['init', '--quiet', '--bare', remote], { stdio: 'ignore', env: gitEnv });
    run(['init', '--quiet', '--initial-branch', 'feature-branch']);
    run(['remote', 'add', 'origin', remote]);
    run(['add', '.']);
    run(['commit', '--quiet', '-m', 'seed']);
    run(['push', '--quiet', 'origin', 'feature-branch']);

    await assertPlanOnRef(root, 'feature-branch', planPath, gitEnv);

    // Remove the plan on the remote. `origin/feature-branch` locally still
    // points at the commit that had it, so anything trusting the tracking
    // ref would wrongly pass.
    run(['rm', '--quiet', planPath]);
    run(['commit', '--quiet', '-m', 'drop plan']);
    run(['push', '--quiet', 'origin', 'feature-branch']);
    run(['update-ref', 'refs/remotes/origin/feature-branch', 'HEAD~1']);

    await assert.rejects(
      () => assertPlanOnRef(root, 'feature-branch', planPath, gitEnv),
      /was not found on origin\/feature-branch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test('returns the pinned remote sha when the working-tree plan differs from the durable remote blob', async () => {
  const remote = mkdtempSync(path.join(tmpdir(), 'theme-review-remote-stale-'));
  const root = repoWithSets(['classic-fantasy']);
  const planPath = 'data/theme-equipment-sets/classic-fantasy.json';
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  const run = (args, cwd = root) =>
    execFileSync('git', args, { cwd, stdio: 'ignore', env: gitEnv });
  try {
    writeFileSync(path.join(root, 'gitconfig'), '[user]\n  name = t\n  email = t@example.com\n');
    execFileSync('git', ['init', '--quiet', '--bare', remote], { stdio: 'ignore', env: gitEnv });
    run(['init', '--quiet', '--initial-branch', 'feature-branch']);
    run(['remote', 'add', 'origin', remote]);
    run(['add', '.']);
    run(['commit', '--quiet', '-m', 'seed']);
    run(['push', '--quiet', 'origin', 'feature-branch']);

    // Overwrite the local working-tree plan without committing or pushing.
    writeFileSync(path.join(root, planPath), `{"id":"classic-fantasy","updated":true}\n`);

    // The durable remote copy is authoritative for init, even when a stale
    // local working-tree file differs.
    const sha = await assertPlanOnRef(root, 'feature-branch', planPath, gitEnv);
    const expected = execFileSync('git', ['rev-parse', 'feature-branch'], {
      cwd: root,
      encoding: 'utf8',
      env: gitEnv,
    }).trim();
    assert.equal(sha, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test('correlates a run to its set by the exact anchored "Theme Equipment <action> · <setId>" title (prefix-collision safe)', () => {
  const runs = [
    {
      databaseId: 11,
      status: 'in_progress',
      conclusion: null,
      url: 'u11',
      createdAt: 't11',
      displayTitle: 'Theme Equipment run-phase · classic-fantasy',
    },
    {
      databaseId: 22,
      status: 'completed',
      conclusion: 'success',
      url: 'u22',
      createdAt: 't22',
      displayTitle: 'Theme Equipment run-phase · classic-fantasy-basic-leather',
    },
  ];
  // The shorter id must NOT match the longer id's run even though it is a prefix.
  const match = selectThemeEquipmentRun(runs, 'classic-fantasy');
  assert.equal(match.databaseId, 11);
  assert.equal(match.status, 'in_progress');
  assert.equal(match.conclusion, null);

  const longer = selectThemeEquipmentRun(runs, 'classic-fantasy-basic-leather');
  assert.equal(longer.databaseId, 22);
  assert.equal(longer.conclusion, 'success');
});

test('does not correlate a run whose crafted set_id merely ends with the requested set id (suffix-spoof safe)', () => {
  const runs = [
    // A manual dispatch with set_id = "other · classic-fantasy" produces a title
    // ending in " · classic-fantasy"; the old suffix match would have shown it as
    // the latest run for "classic-fantasy". The anchored, single-separator match
    // rejects it because the action segment cannot contain a second "·".
    {
      databaseId: 99,
      status: 'in_progress',
      conclusion: null,
      url: 'u99',
      createdAt: 't99',
      displayTitle: 'Theme Equipment run-phase · other · classic-fantasy',
    },
  ];
  assert.equal(selectThemeEquipmentRun(runs, 'classic-fantasy'), null);

  // A legitimate single-separator title for that same id still matches.
  const legit = [
    {
      databaseId: 7,
      status: 'completed',
      conclusion: 'success',
      url: 'u7',
      createdAt: 't7',
      displayTitle: 'Theme Equipment status · classic-fantasy',
    },
  ];
  assert.equal(selectThemeEquipmentRun(legit, 'classic-fantasy').databaseId, 7);
});

test('returns null when no run title carries the set suffix, or the payload is not an array', () => {
  const runs = [{ databaseId: 1, displayTitle: 'Theme Equipment run-phase · other-set' }];
  assert.equal(selectThemeEquipmentRun(runs, 'classic-fantasy'), null);
  assert.equal(selectThemeEquipmentRun(null, 'classic-fantasy'), null);
  assert.equal(selectThemeEquipmentRun('nope', 'classic-fantasy'), null);
});

test('normalizes malformed run fields to null rather than surfacing junk', () => {
  const runs = [
    {
      databaseId: -5, // not a positive integer
      status: 42, // not a string
      conclusion: '', // empty string → null
      url: null,
      createdAt: undefined,
      displayTitle: 'Theme Equipment run-phase · classic-fantasy',
    },
  ];
  const match = selectThemeEquipmentRun(runs, 'classic-fantasy');
  assert.equal(match.databaseId, null);
  assert.equal(match.status, null);
  assert.equal(match.conclusion, null);
  assert.equal(match.url, null);
  assert.equal(match.createdAt, null);
  assert.equal(match.displayTitle, 'Theme Equipment run-phase · classic-fantasy');
});

test('rejects an invalid set id before shelling out to gh', async () => {
  const result = await themeEquipmentRunStatus(process.cwd(), 'not a valid id!!');
  assert.deepEqual(result, { available: false, errorKind: 'invalid-set-id' });
});
