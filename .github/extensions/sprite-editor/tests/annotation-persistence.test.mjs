import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createAnnotationPersistence } from '../lib/annotation-persistence.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const QUEUE_CLI = path.join(REPO_ROOT, 'scripts', 'sprites', 'queue-commit-cli.ts');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function harness(headSprites = {}, stagedSprites = headSprites) {
  let current = { version: 1, sprites: clone(headSprites) };
  let head = { version: 1, sprites: clone(headSprites) };
  let staged = { version: 1, sprites: clone(stagedSprites) };
  let pending = { version: 1, sprites: {} };
  let invalidations = 0;
  const persistence = createAnnotationPersistence({
    readCurrent: () => clone(current),
    writeCurrent: (value) => {
      current = clone(value);
    },
    readHead: async () => clone(head),
    hasStagedChanges: async () => JSON.stringify(staged) !== JSON.stringify(head),
    readPending: () => clone(pending.sprites),
    writePending: (value) => {
      pending = clone(value);
    },
    invalidate: () => {
      invalidations += 1;
    },
  });
  return {
    persistence,
    current: () => clone(current),
    pending: () => clone(pending),
    staged: () => clone(staged),
    invalidations: () => invalidations,
    setCurrent: (value) => {
      current = clone(value);
    },
    setHead: (value) => {
      head = clone(value);
    },
    setStaged: (value) => {
      staged = clone(value);
    },
  };
}

test('successful queue handoff safely cleans the local diff but keeps the favorite visible', async () => {
  const state = harness();
  const token = state.persistence.saveLocal('alpha', {
    favorite: true,
    disliked: true,
    comment: '  Best silhouette.  ',
  });
  assert.deepEqual(state.current().sprites.alpha, {
    favorite: true,
    disliked: false,
    comment: 'Best silhouette.',
  });

  assert.equal(await state.persistence.markDurable(token), true);
  assert.deepEqual(state.current(), { version: 1, sprites: {} }, 'annotation-only diff is clean');
  assert.deepEqual(state.persistence.overlay(state.current()).sprites.alpha, {
    favorite: true,
    disliked: false,
    comment: 'Best silhouette.',
  });

  // Promotion reaches the worktree: the tracked file becomes authoritative and
  // the presentation overlay retires.
  state.setCurrent({
    version: 1,
    sprites: {
      alpha: { favorite: true, disliked: false, comment: 'Best silhouette.' },
    },
  });
  state.persistence.overlay(state.current());
  assert.deepEqual(state.pending().sprites, {});
});

test('failed queueing leaves disliked/comment annotation data intact locally', () => {
  const state = harness();
  state.persistence.saveLocal('beta', {
    favorite: false,
    disliked: true,
    comment: '  Needs another pass.  ',
  });
  // A failed queue request never calls markDurable.
  assert.deepEqual(state.current().sprites.beta, {
    favorite: false,
    disliked: true,
    comment: 'Needs another pass.',
  });
  assert.deepEqual(state.pending().sprites, {});
});

test('an earlier successful request cannot clean a rapid newer local save', async () => {
  let releaseHead;
  const headRead = new Promise((resolve) => {
    releaseHead = resolve;
  });
  let current = { version: 1, sprites: {} };
  let pending = { version: 1, sprites: {} };
  const persistence = createAnnotationPersistence({
    readCurrent: () => clone(current),
    writeCurrent: (value) => {
      current = clone(value);
    },
    readHead: async () => {
      await headRead;
      return { version: 1, sprites: {} };
    },
    readPending: () => clone(pending.sprites),
    writePending: (value) => {
      pending = clone(value);
    },
    invalidate: () => {},
  });

  const first = persistence.saveLocal('alpha', {
    favorite: true,
    disliked: false,
    comment: 'first',
  });
  const firstCompletion = persistence.markDurable(first);
  const second = persistence.saveLocal('alpha', {
    favorite: false,
    disliked: true,
    comment: 'second',
  });
  releaseHead();

  assert.equal(await firstCompletion, false);
  assert.deepEqual(current.sprites.alpha, {
    favorite: false,
    disliked: true,
    comment: 'second',
  });
  assert.equal(await persistence.markDurable(second), true);
  assert.deepEqual(current, { version: 1, sprites: {} });
});

test('saving another sprite never persists a pending presentation overlay', async () => {
  const state = harness();
  const alpha = state.persistence.saveLocal('alpha', {
    favorite: true,
    disliked: false,
    comment: 'queued alpha',
  });
  assert.equal(await state.persistence.markDurable(alpha), true);
  const presented = state.persistence.overlay(state.current());
  assert.equal(presented.sprites.alpha.comment, 'queued alpha');

  state.persistence.saveLocal('beta', {
    favorite: false,
    disliked: true,
    comment: 'local beta',
  });
  assert.deepEqual(state.current().sprites, {
    beta: { favorite: false, disliked: true, comment: 'local beta' },
  });
});

test('a pre-existing staged edit anywhere in the aggregate blocks cleanup and keeps both copies intact', async () => {
  const state = harness(
    { alpha: { favorite: false, disliked: false, comment: 'released' } },
    {
      alpha: { favorite: false, disliked: false, comment: 'released' },
      beta: { favorite: false, disliked: false, comment: 'operator staged this manually' },
    },
  );
  const token = state.persistence.saveLocal('alpha', {
    favorite: true,
    disliked: true,
    comment: 'editor dislike',
  });

  await assert.rejects(
    () => state.persistence.markDurable(token),
    /already has a staged edit|staging state/,
  );

  // The just-queued local annotation is retained -- cleanup never ran.
  assert.deepEqual(state.current().sprites.alpha, {
    favorite: true,
    disliked: false,
    comment: 'editor dislike',
  });
  // The operator's pre-existing staged copy is untouched.
  assert.deepEqual(state.staged().sprites.beta, {
    favorite: false,
    disliked: false,
    comment: 'operator staged this manually',
  });
  // No pending presentation overlay was written for an aborted cleanup.
  assert.deepEqual(state.pending().sprites, {});
});

test('Sprite Editor annotation-only save reaches assets/queue and leaves no tracked diff', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sprite-editor-annotation-'));
  const origin = path.join(root, 'origin.git');
  const live = path.join(root, 'live');
  const annotationPath = path.join(
    live,
    'public',
    'assets',
    'generated',
    'sprite-editor-annotations.json',
  );
  try {
    mkdirSync(origin);
    mkdirSync(live);
    git(origin, 'init', '--bare', '-b', 'main');
    git(live, 'init', '-b', 'main');
    git(live, 'config', 'user.email', 'test@example.com');
    git(live, 'config', 'user.name', 'Sprite Editor Test');
    git(live, 'config', 'commit.gpgsign', 'false');
    git(live, 'remote', 'add', 'origin', origin.split(path.sep).join('/'));
    writeJson(annotationPath, { version: 1, sprites: {} });
    git(live, 'add', '-A');
    git(live, 'commit', '-m', 'base');
    git(live, 'push', 'origin', 'main');

    let pending = { version: 1, sprites: {} };
    const persistence = createAnnotationPersistence({
      readCurrent: () => JSON.parse(readFileSync(annotationPath, 'utf8')),
      writeCurrent: (value) => writeJson(annotationPath, value),
      readHead: async () =>
        JSON.parse(
          git(live, 'show', 'HEAD:public/assets/generated/sprite-editor-annotations.json'),
        ),
      readPending: () => clone(pending.sprites),
      writePending: (value) => {
        pending = clone(value);
      },
      invalidate: () => {},
    });
    const token = persistence.saveLocal('alpha', {
      favorite: true,
      disliked: true,
      comment: '  Durable exemplar.  ',
    });
    const encoded = Buffer.from(JSON.stringify({ key: token.key, ...token.annotation })).toString(
      'base64url',
    );
    const localEnv = { ...process.env };
    delete localEnv.CI;
    const output = execFileSync(
      process.execPath,
      [
        TSX_CLI,
        QUEUE_CLI,
        '--repo-root',
        live,
        '--annotation-json',
        encoded,
        '--message',
        'chore(assets): annotate alpha',
      ],
      { cwd: live, encoding: 'utf8', env: localEnv },
    );
    assert.equal(JSON.parse(output.trim()).status, 'committed');
    assert.equal(await persistence.markDurable(token), true);

    git(live, 'fetch', '--no-tags', 'origin', 'assets/queue');
    assert.deepEqual(
      JSON.parse(
        git(live, 'show', 'FETCH_HEAD:public/assets/generated/sprite-editor-annotations.json'),
      ).sprites.alpha,
      { favorite: true, disliked: false, comment: 'Durable exemplar.' },
    );
    assert.equal(
      git(live, 'diff', '--', 'public/assets/generated/sprite-editor-annotations.json'),
      '',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pre-existing staged edit surfaces a cleanup failure and never gets erased by a real git index', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sprite-editor-annotation-staged-'));
  const origin = path.join(root, 'origin.git');
  const live = path.join(root, 'live');
  const annotationPath = path.join(
    live,
    'public',
    'assets',
    'generated',
    'sprite-editor-annotations.json',
  );
  const relAnnotationPath = 'public/assets/generated/sprite-editor-annotations.json';
  try {
    mkdirSync(origin);
    mkdirSync(live);
    git(origin, 'init', '--bare', '-b', 'main');
    git(live, 'init', '-b', 'main');
    git(live, 'config', 'user.email', 'test@example.com');
    git(live, 'config', 'user.name', 'Sprite Editor Test');
    git(live, 'config', 'commit.gpgsign', 'false');
    git(live, 'remote', 'add', 'origin', origin.split(path.sep).join('/'));
    writeJson(annotationPath, {
      version: 1,
      sprites: { alpha: { favorite: false, disliked: false, comment: 'released' } },
    });
    git(live, 'add', '-A');
    git(live, 'commit', '-m', 'base');
    git(live, 'push', 'origin', 'main');

    let pending = { version: 1, sprites: {} };
    const persistence = createAnnotationPersistence({
      readCurrent: () => JSON.parse(readFileSync(annotationPath, 'utf8')),
      writeCurrent: (value) => writeJson(annotationPath, value),
      readHead: async () => JSON.parse(git(live, 'show', `HEAD:${relAnnotationPath}`)),
      hasStagedChanges: async () => {
        const result = spawnSync('git', ['diff', '--cached', '--quiet', '--', relAnnotationPath], {
          cwd: live,
          encoding: 'utf8',
        });
        if (result.status === 0) return false;
        if (result.status === 1) return true;
        throw new Error(result.stderr || result.stdout || `git diff exited ${result.status}`);
      },
      readPending: () => clone(pending.sprites),
      writePending: (value) => {
        pending = clone(value);
      },
      invalidate: () => {},
    });
    // Stage a user-owned edit for ANOTHER key. Cleanup still cannot claim the
    // shared annotations file is clean without touching that staged state.
    writeJson(annotationPath, {
      version: 1,
      sprites: {
        alpha: { favorite: false, disliked: false, comment: 'released' },
        beta: { favorite: false, disliked: false, comment: 'operator staged this manually' },
      },
    });
    git(live, 'add', '-A');
    const stagedBefore = git(live, 'show', `:${relAnnotationPath}`);

    // The editor adds its working-tree-only annotation for alpha.
    const token = persistence.saveLocal('alpha', {
      favorite: true,
      disliked: true,
      comment: '  Editor dislike.  ',
    });
    const encoded = Buffer.from(JSON.stringify({ key: token.key, ...token.annotation })).toString(
      'base64url',
    );
    const localEnv = { ...process.env };
    delete localEnv.CI;
    const output = execFileSync(
      process.execPath,
      [
        TSX_CLI,
        QUEUE_CLI,
        '--repo-root',
        live,
        '--annotation-json',
        encoded,
        '--message',
        'chore(assets): annotate alpha',
      ],
      { cwd: live, encoding: 'utf8', env: localEnv },
    );
    assert.equal(JSON.parse(output.trim()).status, 'committed');

    await assert.rejects(
      () => persistence.markDurable(token),
      /already has a staged edit.*git restore --staged/s,
    );

    // The queued local annotation is retained -- cleanup never touched the file.
    assert.deepEqual(JSON.parse(readFileSync(annotationPath, 'utf8')).sprites.alpha, {
      favorite: true,
      disliked: false,
      comment: 'Editor dislike.',
    });
    assert.deepEqual(JSON.parse(readFileSync(annotationPath, 'utf8')).sprites.beta, {
      favorite: false,
      disliked: false,
      comment: 'operator staged this manually',
    });
    // The operator's real git-index staged blob is byte-identical to before --
    // nothing erased it, and no pending overlay was written for the aborted
    // cleanup.
    assert.equal(git(live, 'show', `:${relAnnotationPath}`), stagedBefore);
    assert.deepEqual(pending.sprites, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
