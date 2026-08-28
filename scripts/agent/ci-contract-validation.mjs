import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = path.join(root, 'schemas/ci-lifecycle/v1.schema.json');
const inventoryPath = path.join(root, 'schemas/ci-lifecycle/inventory.json');
const requiredWorkflows = [
  '.github/workflows/ci-recovery-router.yml',
  '.github/workflows/ci-recovery.yml',
  '.github/workflows/merge-train.yml',
  '.github/workflows/merge-train-validate.yml',
  '.github/workflows/goobers-run.yml',
  '.github/workflows/goobers-validate.yml',
];
const mutationClasses = new Set([
  'dispatch',
  'label',
  'comment',
  'branch-ref',
  'check',
  'artifact',
  'credential',
  'state',
]);
const phases = new Set([
  'absent',
  'acquiring',
  'held',
  'renewed',
  'releasing',
  'released',
  'expired',
  'takeover',
]);
const actions = new Set([
  'acquired',
  'renewed',
  'released',
  'takeover',
  'reconciled',
  'none',
  'rejected',
]);
const sha = /^[0-9a-f]{40}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const timestamp = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function validateEnvelope(value) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['envelope must be an object'];
  const allowed =
    value.kind === 'invocation'
      ? [
          'contractVersion',
          'kind',
          'repository',
          'resource',
          'workflow',
          'trigger',
          'expectedHeadSha',
          'expectedBaseRef',
          'operation',
          'trustedRef',
          'lease',
        ]
      : [
          'contractVersion',
          'kind',
          'runId',
          'repository',
          'resource',
          'headSha',
          'lifecyclePhase',
          'status',
          'disposition',
          'action',
          'outputs',
          'error',
          'timestamps',
        ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`unknown property: ${key}`);
  if (value.contractVersion !== 'v1') fail('contractVersion must be v1');
  if (!repository.test(value.repository ?? '')) fail('repository is invalid');
  if (
    !value.resource ||
    value.resource.repository !== value.repository ||
    !Number.isInteger(value.resource.prNumber) ||
    value.resource.prNumber < 1
  ) {
    fail('resource must contain a matching positive prNumber');
  }
  if (value.kind === 'invocation') {
    if (!id.test(value.workflow ?? '')) fail('workflow is invalid');
    if (
      !['issue-label', 'pull-request', 'review', 'workflow-run', 'schedule', 'manual'].includes(
        value.trigger,
      )
    )
      fail('trigger is invalid');
    if (!sha.test(value.expectedHeadSha ?? '')) fail('expectedHeadSha is invalid');
    if (
      typeof value.expectedBaseRef !== 'string' ||
      !/^[A-Za-z0-9._/-]{1,255}$/.test(value.expectedBaseRef)
    )
      fail('expectedBaseRef is invalid');
    if (
      !['reconcile', 'lease-acquire', 'lease-heartbeat', 'lease-release'].includes(value.operation)
    )
      fail('operation is invalid');
    const lease = value.lease;
    const expectedKey = `crawler.lifecycle.v1/${value.repository}/${value.resource?.prNumber}/${String(value.expectedHeadSha).toLowerCase()}/${value.operation}`;
    if (
      !lease ||
      lease.idempotencyKey !== expectedKey ||
      !id.test(lease.ownerRunId ?? '') ||
      !id.test(lease.leaseId ?? '')
    )
      fail('lease identity is invalid or does not bind to the operation');
    for (const key of ['acquiredAt', 'renewedAt', 'expiresAt'])
      if (lease?.[key] !== undefined && !timestamp(lease[key])) fail(`${key} is invalid`);
    return errors;
  }
  if (value.kind !== 'state') fail('kind must be invocation or state');
  if (!id.test(value.runId ?? '')) fail('runId is invalid');
  if (!sha.test(value.headSha ?? '')) fail('headSha is invalid');
  if (!phases.has(value.lifecyclePhase)) fail('lifecyclePhase is unknown');
  if (!['succeeded', 'failed', 'skipped'].includes(value.status)) fail('status is invalid');
  if (!['acted', 'no-op', 'blocked', 'error'].includes(value.disposition))
    fail('disposition is invalid');
  if (!actions.has(value.action)) fail('action is unknown');
  if (!value.outputs || typeof value.outputs !== 'object' || Array.isArray(value.outputs))
    fail('outputs must be an object');
  if (
    value.error !== null &&
    (!value.error ||
      typeof value.error !== 'object' ||
      !id.test(value.error.code ?? '') ||
      typeof value.error.message !== 'string')
  )
    fail('error is invalid');
  if (!value.timestamps || !timestamp(value.timestamps.observedAt)) fail('observedAt is invalid');
  if (value.status === 'succeeded' && !['acted', 'no-op'].includes(value.disposition))
    fail('success must be acted or no-op');
  if (value.disposition === 'no-op' && value.action !== 'none') fail('no-op must have action none');
  if (value.status === 'failed' && !value.error?.code) fail('failed state requires an error');
  return errors;
}

export function transitionLease(
  current,
  next,
  { ownerRunId, leaseId, currentOwnerRunId, currentLeaseId, now, expiresAt },
) {
  const allowed = {
    absent: ['acquiring'],
    acquiring: ['held'],
    held: ['renewed', 'releasing', 'expired'],
    renewed: ['renewed', 'releasing', 'expired'],
    releasing: ['released'],
    released: [],
    expired: ['takeover'],
    takeover: ['held'],
  };
  if (!phases.has(current) || !phases.has(next) || !allowed[current].includes(next)) {
    throw new Error(`invalid lease transition ${current} -> ${next}`);
  }
  if (current !== 'absent' && next !== 'takeover' && (!ownerRunId || !leaseId)) {
    throw new Error('lease ownership is required');
  }
  if (
    current !== 'absent' &&
    next !== 'takeover' &&
    ((currentOwnerRunId && currentOwnerRunId !== ownerRunId) ||
      (currentLeaseId && currentLeaseId !== leaseId))
  ) {
    throw new Error('stale lease owner cannot mutate ownership');
  }
  if (current === 'expired' && next === 'takeover' && typeof now !== 'number') {
    throw new Error('takeover requires a clock');
  }
  if (next === 'held' && (!expiresAt || expiresAt <= (now ?? 0)))
    throw new Error('held lease must have a future expiry');
  return next;
}

function validateInventory() {
  const inventory = readJson(inventoryPath);
  if (inventory.contractVersion !== 'v1') throw new Error('inventory contractVersion must be v1');
  const rows = new Map(inventory.workflows?.map((row) => [row.path, row]) ?? []);
  for (const workflow of requiredWorkflows) {
    const row = rows.get(workflow);
    if (!row) throw new Error(`missing inventory row: ${workflow}`);
    if (!row.owner || !row.guard || !Array.isArray(row.sites) || row.sites.length === 0)
      throw new Error(`incomplete inventory row: ${workflow}`);
    for (const site of row.sites) {
      if (
        !Number.isInteger(site.line) ||
        site.line < 1 ||
        !mutationClasses.has(site.class) ||
        !site.operation ||
        !site.target
      ) {
        throw new Error(`unclassified mutation site in ${workflow}`);
      }
      if (!readFileSync(path.join(root, workflow), 'utf8').split(/\r?\n/)[site.line - 1])
        throw new Error(`line outside workflow: ${workflow}:${site.line}`);
    }
  }
}

export function validateRepository() {
  readJson(schemaPath);
  validateInventory();
  const fixtureDir = path.join(root, 'fixtures/ci-lifecycle');
  const fixtures = readdirSync(fixtureDir).filter((file) => file.endsWith('.json'));
  if (!fixtures.includes('invocation.json') || !fixtures.includes('state.json'))
    throw new Error('required valid fixtures are missing');
  for (const file of fixtures) {
    const errors = validateEnvelope(readJson(path.join(fixtureDir, file)));
    const expectedInvalid = file.startsWith('invalid-');
    if (expectedInvalid !== errors.length > 0)
      throw new Error(`${file} validation expectation failed: ${errors.join('; ')}`);
  }
  transitionLease('absent', 'acquiring', {});
  transitionLease('acquiring', 'held', {
    ownerRunId: 'run',
    leaseId: 'lease',
    now: 10,
    expiresAt: 20,
  });
  transitionLease('held', 'renewed', { ownerRunId: 'run', leaseId: 'lease' });
  transitionLease('renewed', 'releasing', { ownerRunId: 'run', leaseId: 'lease' });
  transitionLease('releasing', 'released', { ownerRunId: 'run', leaseId: 'lease' });
  transitionLease('held', 'expired', { ownerRunId: 'run', leaseId: 'lease' });
  transitionLease('expired', 'takeover', { now: 100 });
  transitionLease('takeover', 'held', {
    ownerRunId: 'new-run',
    leaseId: 'new-lease',
    now: 100,
    expiresAt: 200,
  });
  return { workflows: requiredWorkflows.length, fixtures: fixtures.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = validateRepository();
    console.log(
      `CI lifecycle contract validation passed (${result.workflows} workflows, ${result.fixtures} fixtures).`,
    );
  } catch (error) {
    console.error(`CI lifecycle contract validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
