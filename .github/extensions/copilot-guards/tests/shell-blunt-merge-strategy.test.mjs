import test from 'node:test';
import assert from 'node:assert/strict';
import guard from '../guards/shell-blunt-merge-strategy.mjs';

function run(cmd) {
  return guard.check({ command: cmd });
}

function denies(cmd) {
  const r = run(cmd);
  assert.equal(r.decision, 'deny', `expected deny for: ${cmd}`);
  assert.match(r.reason, /git reset --hard/);
  assert.match(r.reason, /git checkout <ref> -- <paths>/);
  return r;
}

function allows(cmd) {
  const r = run(cmd);
  assert.equal(r.decision, 'allow', `expected allow for: ${cmd}`);
}

// ── denied: -X theirs/ours in every spelling ────────────────────────────────

test('denies git merge -X theirs', () => {
  denies('git merge -X theirs origin/main');
});

test('denies git merge -X ours', () => {
  denies('git merge -X ours origin/main');
});

test('denies git merge -Xtheirs (attached form)', () => {
  denies('git merge -Xtheirs origin/main');
});

test('denies git merge -Xours (attached form)', () => {
  denies('git merge -Xours origin/main');
});

test('denies --strategy-option=theirs', () => {
  denies('git merge --strategy-option=theirs origin/main');
});

test('denies --strategy-option=ours', () => {
  denies('git merge --strategy-option=ours origin/main');
});

test('denies --strategy-option theirs (space form)', () => {
  denies('git merge --strategy-option theirs origin/main');
});

test('denies --strategy-option ours (space form)', () => {
  denies('git merge --strategy-option ours origin/main');
});

// ── denied: the `ours` strategy ─────────────────────────────────────────────

test('denies -s ours', () => {
  denies('git merge -s ours origin/main');
});

test('denies -sours (attached form)', () => {
  denies('git merge -sours origin/main');
});

test('denies --strategy=ours', () => {
  denies('git merge --strategy=ours origin/main');
});

test('denies --strategy ours (space form)', () => {
  denies('git merge --strategy ours origin/main');
});

// ── denied on rebase / cherry-pick / pull too ───────────────────────────────

test('denies git rebase -X theirs', () => {
  denies('git rebase -X theirs main');
});

test('denies git cherry-pick -X ours', () => {
  denies('git cherry-pick -X ours abc1234');
});

test('denies git pull -X theirs', () => {
  denies('git pull -X theirs origin main');
});

test('denies git pull --strategy-option=ours', () => {
  denies('git pull --strategy-option=ours origin main');
});

// ── denied: --allow-unrelated-histories without acknowledgement ─────────────

test('denies --allow-unrelated-histories without the ack env var', () => {
  const r = run('git merge --allow-unrelated-histories assets/queue');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /CRAWLER_ALLOW_UNRELATED_HISTORIES=1/);
});

test('denies --allow-unrelated-histories on git pull without the ack env var', () => {
  const r = run('git pull --allow-unrelated-histories origin assets/queue');
  assert.equal(r.decision, 'deny');
});

test('allows --allow-unrelated-histories with the ack env var inline', () => {
  allows('CRAWLER_ALLOW_UNRELATED_HISTORIES=1 git merge --allow-unrelated-histories assets/queue');
});

test('allows --allow-unrelated-histories when the ack is exported in the same chain', () => {
  allows(
    'export CRAWLER_ALLOW_UNRELATED_HISTORIES=1 && git merge --allow-unrelated-histories assets/queue',
  );
});

test('allows --allow-unrelated-histories when env(1) sets the ack inline on the guarded segment', () => {
  allows(
    'env -i CRAWLER_ALLOW_UNRELATED_HISTORIES=1 git merge --allow-unrelated-histories assets/queue',
  );
});

test('ack env var does not license -X theirs', () => {
  denies('CRAWLER_ALLOW_UNRELATED_HISTORIES=1 git merge -X theirs origin/main');
});

test('ack env var set to something other than 1 does not license unrelated histories', () => {
  const r = run('CRAWLER_ALLOW_UNRELATED_HISTORIES=0 git merge --allow-unrelated-histories other');
  assert.equal(r.decision, 'deny');
});

test('ack text in a previous non-export segment does not license unrelated histories', () => {
  const r = run(
    'echo CRAWLER_ALLOW_UNRELATED_HISTORIES=1 && git merge --allow-unrelated-histories assets/queue',
  );
  assert.equal(r.decision, 'deny');
});

test('an inline ack on a previous non-export command does not persist to a later segment', () => {
  const r = run(
    'CRAWLER_ALLOW_UNRELATED_HISTORIES=1 echo ok && git merge --allow-unrelated-histories assets/queue',
  );
  assert.equal(r.decision, 'deny');
});

// ── env-prefix / wrapper / chaining bypasses ────────────────────────────────

test('denies through an unrelated env prefix', () => {
  denies('GIT_AUTHOR_NAME=bot git merge -X theirs origin/main');
});

test('denies through env(1)', () => {
  denies('env GIT_AUTHOR_NAME=bot git merge -X theirs origin/main');
});

test('denies through env(1) option wrappers too', () => {
  denies('env -i git merge -X theirs origin/main');
  denies('env --ignore-environment git merge -X ours origin/main');
  denies('env -u HOME git merge --strategy-option=theirs origin/main');
  denies('env --unset=HOME git merge --strategy-option=ours origin/main');
});

test('denies with .exe', () => {
  denies('git.exe merge -X theirs origin/main');
});

test('denies with git global options before the subcommand', () => {
  denies('git -C /repo -c core.pager=cat merge -X ours origin/main');
});

test('detects across && chain', () => {
  denies('git fetch origin && git merge -X theirs origin/main');
});

test('detects across ; chain', () => {
  denies('echo start ; git merge --strategy-option=theirs origin/main ; echo done');
});

test('detects across line continuation', () => {
  denies('git merge \\\n  -X theirs \\\n  origin/main');
});

test('detects inside a bash -c wrapper', () => {
  denies('bash -c "git merge -X theirs origin/main"');
});

// ── explicit allow cases ────────────────────────────────────────────────────

test('allows path-scoped git checkout --theirs <path>', () => {
  allows('git checkout --theirs src/shared/inventory.ts');
});

test('allows path-scoped git checkout --ours <path>', () => {
  allows('git checkout --ours .github/agents/set-piece-designer.agent.md');
});

test('allows the sanctioned remediation shape', () => {
  allows('git reset --hard origin/main && git checkout feature -- src/game/weaponSystem.ts');
});

test('allows a plain merge with no strategy options', () => {
  allows('git merge origin/main');
});

test('allows a branch literally named "ours"', () => {
  allows('git merge ours');
});

test('allows a branch literally named "theirs" on a pull', () => {
  allows('git pull origin theirs');
});

test('allows the word "theirs" inside a quoted commit message', () => {
  allows('git commit -m "merge: take theirs for the sprite manifest"');
});

test('allows a merge whose quoted message mentions -X theirs', () => {
  allows('git merge --no-ff origin/main -m "do not use -X theirs here"');
});

test('allows a non-side -X strategy option', () => {
  allows('git merge -X ignore-space-change origin/main');
});

test('allows an explicit non-destructive strategy', () => {
  allows('git merge -s ort origin/main');
  allows('git merge --strategy=recursive origin/main');
});

test('allows git rebase with no strategy options', () => {
  allows('git rebase origin/main');
});

test('allows unrelated shell commands', () => {
  allows('ls -la');
  allows('npm run verify:fast');
});

// ── matches() is cheap and does not fire on unrelated commands ──────────────

test('matches() returns false for unrelated commands', () => {
  assert.equal(guard.matches('bash', { command: 'ls -la' }), false);
  assert.equal(guard.matches('bash', { command: 'git status' }), false);
  assert.equal(guard.matches('bash', { command: 'git merge origin/main' }), false);
  assert.equal(guard.matches('edit', { path: 'src/foo.ts' }), false);
  assert.equal(guard.matches('bash', { command: 'npm run test:guards' }), false);
});

test('matches() returns true for the dangerous shapes', () => {
  assert.equal(guard.matches('bash', { command: 'git merge -X theirs origin/main' }), true);
  assert.equal(guard.matches('powershell', { command: 'git merge -s ours origin/main' }), true);
  assert.equal(
    guard.matches('bash', { command: 'git merge --allow-unrelated-histories assets/queue' }),
    true,
  );
});

test('guard shape mirrors the other shell guards', () => {
  assert.equal(guard.id, 'shell-blunt-merge-strategy');
  assert.equal(guard.category, 'shell');
  assert.equal(guard.failClosed, true);
  assert.equal(typeof guard.matches, 'function');
  assert.equal(typeof guard.check, 'function');
});
