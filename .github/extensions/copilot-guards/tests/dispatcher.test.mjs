import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatch } from '../lib/dispatcher.mjs';

// The dispatcher appends a telemetry event to `<ctx.cwd>/files/guard-telemetry.jsonl`
// on every guard decision. If ctx.cwd were process.cwd() (the repo root when the
// suite runs), these synthetic fixture events — including the real configured id
// `edit-guard-self-protection` used below — would pollute the real artifact that
// feeds cross-session telemetry analysis. Point every dispatch test at a throwaway
// temp dir so the suite can never contaminate that artifact.
const telemetryCwd = mkdtempSync(path.join(tmpdir(), 'guard-dispatch-'));
after(() => rmSync(telemetryCwd, { recursive: true, force: true }));

const noopCtx = { cwd: telemetryCwd, log: async () => {} };

test('dispatch returns undefined when no guards match', async () => {
  const result = await dispatch(
    [
      {
        id: 'x',
        matches: () => false,
        check: () => ({ decision: 'deny', reason: 'should not fire' }),
      },
    ],
    'view',
    {},
    noopCtx,
  );
  assert.equal(result, undefined);
});

test('dispatch returns first deny from shell category', async () => {
  const result = await dispatch(
    [
      {
        id: 'shell-a',
        category: 'shell',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'bad' }),
      },
      {
        id: 'shell-b',
        category: 'shell',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'also bad' }),
      },
    ],
    'powershell',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /shell-a/);
  assert.doesNotMatch(result.permissionDecisionReason, /shell-b/);
});

test('dispatch aggregates pr-category denies', async () => {
  const result = await dispatch(
    [
      {
        id: 'pr-a',
        category: 'pr',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'issue A' }),
      },
      {
        id: 'pr-b',
        category: 'pr',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'issue B' }),
      },
    ],
    'create_pull_request',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /pr-a/);
  assert.match(result.permissionDecisionReason, /pr-b/);
});

test('dispatch fail-closed deny on crash', async () => {
  const result = await dispatch(
    [
      {
        id: 'boom',
        category: 'shell',
        failClosed: true,
        matches: () => true,
        check: () => {
          throw new Error('kaboom');
        },
      },
    ],
    'powershell',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /kaboom/);
});

test('dispatch fail-open allow on crash by default', async () => {
  const result = await dispatch(
    [
      {
        id: 'boom',
        matches: () => true,
        check: () => {
          throw new Error('oops');
        },
      },
    ],
    'edit',
    {},
    noopCtx,
  );
  assert.equal(result, undefined);
});

test('dispatch collects additionalContext from allowed guards', async () => {
  const result = await dispatch(
    [
      {
        id: 'ctx-a',
        matches: () => true,
        check: () => ({ decision: 'allow', additionalContext: 'note A' }),
      },
      {
        id: 'ctx-b',
        matches: () => true,
        check: () => ({ decision: 'allow', additionalContext: 'note B' }),
      },
    ],
    'edit',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'allow');
  assert.match(result.additionalContext, /note A/);
  assert.match(result.additionalContext, /note B/);
});

test('env var COPILOT_GUARDS_DISABLE bypasses guard', async () => {
  process.env.COPILOT_GUARDS_DISABLE = 'edit-bad';
  const result = await dispatch(
    [
      {
        id: 'edit-bad',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'should be bypassed' }),
      },
    ],
    'edit',
    {},
    noopCtx,
  );
  assert.equal(result, undefined);
  delete process.env.COPILOT_GUARDS_DISABLE;
});

test('dispatch surfaces additionalContext alongside a non-pr deny', async () => {
  const result = await dispatch(
    [
      {
        id: 'ctx',
        matches: () => true,
        check: () => ({ decision: 'allow', additionalContext: 'soft warning' }),
      },
      {
        id: 'shell-bad',
        category: 'shell',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'hard fail' }),
      },
    ],
    'powershell',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /hard fail/);
  assert.match(result.additionalContext, /soft warning/);
});

test('dispatch surfaces additionalContext from pr guards when aggregating denies', async () => {
  const result = await dispatch(
    [
      {
        id: 'pr-warn',
        category: 'pr',
        matches: () => true,
        check: () => ({ decision: 'allow', additionalContext: 'ADR hint' }),
      },
      {
        id: 'pr-hard',
        category: 'pr',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'real failure' }),
      },
    ],
    'create_pull_request',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /real failure/);
  assert.match(result.additionalContext, /ADR hint/);
});

test('dispatch surfaces additionalContext attached to a deny result itself', async () => {
  const result = await dispatch(
    [
      {
        id: 'shell-bad',
        category: 'shell',
        matches: () => true,
        check: () => ({
          decision: 'deny',
          reason: 'main reason',
          additionalContext: 'extra context attached to the deny',
        }),
      },
    ],
    'powershell',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.additionalContext, /extra context attached to the deny/);
});

test('dispatch downgrades deny to ask when guardSeverity returns ask', async () => {
  // edit-guard-self-protection is configured with severity: "ask" in
  // config.json. Even if a guard returns deny, the dispatcher must
  // honor that and emit ask instead.
  const result = await dispatch(
    [
      {
        id: 'edit-guard-self-protection',
        category: 'edit',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'would-be-deny' }),
      },
    ],
    'edit',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'ask');
  assert.match(result.permissionDecisionReason, /would-be-deny/);
});

test('dispatch never upgrades ask to deny via severity', async () => {
  const result = await dispatch(
    [
      {
        id: 'edit-guard-self-protection',
        category: 'edit',
        matches: () => true,
        check: () => ({ decision: 'ask', reason: 'confirm me' }),
      },
    ],
    'edit',
    {},
    noopCtx,
  );
  assert.equal(result.permissionDecision, 'ask');
});

test('guard telemetry is written under the isolated temp cwd, never the repo root', async () => {
  await dispatch(
    [
      {
        id: 'shell-bad',
        category: 'shell',
        matches: () => true,
        check: () => ({ decision: 'deny', reason: 'isolation probe' }),
      },
    ],
    'powershell',
    {},
    noopCtx,
  );
  const artifact = path.join(telemetryCwd, 'files', 'guard-telemetry.jsonl');
  assert.ok(existsSync(artifact), 'telemetry must land in the isolated temp cwd');
  assert.notEqual(
    path.resolve(telemetryCwd),
    path.resolve(process.cwd()),
    'dispatch tests must not use the repo root as cwd',
  );
});
