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
