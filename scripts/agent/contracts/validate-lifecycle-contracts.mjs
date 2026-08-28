#!/usr/bin/env node
/* global console */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const contracts = join(root, '.github/contracts');
const inventory = JSON.parse(readFileSync(join(contracts, 'mutation-inventory.json'), 'utf8'));
const invariantFixture = JSON.parse(
  readFileSync(join(contracts, 'fixtures/invariants.v1.json'), 'utf8'),
);
const errors = [];

function fail(message) {
  errors.push(message);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  return value ?? {};
}

function string(value, path, pattern) {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) fail(`${path} is malformed`);
}

function validateContract(value, path, decision) {
  const data = object(value, path);
  const required = [
    'contractVersion',
    'resource',
    'operation',
    'actor',
    'sourceEvent',
    'expected',
    'idempotencyKey',
    'lease',
    'outcome',
    'error',
  ];
  if (decision) required.push('decision');
  for (const key of required) if (!(key in data)) fail(`${path}.${key} is required`);
  if (data.contractVersion !== 'v1') fail(`${path}.contractVersion must be v1`);
  const resource = object(data.resource, `${path}.resource`);
  string(resource.kind, `${path}.resource.kind`, /^[a-z][a-z0-9-]*$/);
  string(resource.repository, `${path}.resource.repository`, /^[^/\s]+\/[^/\s]+$/);
  string(resource.id, `${path}.resource.id`, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
  if (
    !['claim', 'start', 'update', 'release', 'takeover', 'dispatch', 'publish'].includes(
      data.operation,
    )
  )
    fail(`${path}.operation is unsupported`);
  const actor = object(data.actor, `${path}.actor`);
  if (!['workflow', 'app', 'goobers', 'human'].includes(actor.kind))
    fail(`${path}.actor.kind is unsupported`);
  string(actor.id, `${path}.actor.id`, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
  const event = object(data.sourceEvent, `${path}.sourceEvent`);
  string(event.name, `${path}.sourceEvent.name`, /^[a-z][a-z0-9_-]*$/);
  string(event.id, `${path}.sourceEvent.id`, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
  const expected = object(data.expected, `${path}.expected`);
  if (
    !(
      expected.headSha === null ||
      (typeof expected.headSha === 'string' && /^[0-9a-f]{40}$/.test(expected.headSha))
    )
  )
    fail(`${path}.expected.headSha is malformed`);
  if (
    !(
      expected.baseRef === null ||
      (typeof expected.baseRef === 'string' &&
        /^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(expected.baseRef))
    )
  )
    fail(`${path}.expected.baseRef is malformed`);
  if (!Number.isInteger(expected.generation) || expected.generation < 0)
    fail(`${path}.expected.generation is malformed`);
  string(
    data.idempotencyKey,
    `${path}.idempotencyKey`,
    /^v1:crawler:v1:[a-z0-9-]+:[^:]+:[^:]+:[^:]+:[0-9]+$/,
  );
  const lease = object(data.lease, `${path}.lease`);
  string(lease.owner, `${path}.lease.owner`, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
  if (!Number.isInteger(lease.fencingToken) || lease.fencingToken < 1)
    fail(`${path}.lease.fencingToken is malformed`);
  if (!['unowned', 'claimed', 'active', 'released', 'expired', 'takeover'].includes(lease.state))
    fail(`${path}.lease.state is unsupported`);
  if (!['success', 'skipped', 'failed'].includes(data.outcome))
    fail(`${path}.outcome is unsupported`);
  if (
    data.error !== null &&
    (!data.error || typeof data.error !== 'object' || typeof data.error.retryable !== 'boolean')
  )
    fail(`${path}.error must be null or a fail-closed error`);
  if (decision) {
    const result = object(data.decision, `${path}.decision`);
    if (
      !['pending', 'approved', 'rejected', 'terminal'].includes(result.status) ||
      !Number.isInteger(result.generation) ||
      result.generation < 0
    )
      fail(`${path}.decision is malformed`);
  }
  const allowed = new Set([...required]);
  for (const key of Object.keys(data)) if (!allowed.has(key)) fail(`${path}.${key} is unknown`);
  return errors.length === 0;
}

function validateFixtures() {
  const validInvocation = JSON.parse(
    readFileSync(join(contracts, 'fixtures/valid-invocation.json'), 'utf8'),
  );
  const validDecision = JSON.parse(
    readFileSync(join(contracts, 'fixtures/valid-decision.json'), 'utf8'),
  );
  const before = errors.length;
  validateContract(validInvocation, 'valid invocation', false);
  validateContract(validDecision, 'valid decision', true);
  if (errors.length !== before) fail('valid fixtures must pass');
  const invalid = JSON.parse(
    readFileSync(join(contracts, 'fixtures/invalid-version.json'), 'utf8'),
  );
  const invalidBefore = errors.length;
  validateContract(invalid, 'invalid fixture', false);
  const invalidErrors = errors.splice(invalidBefore);
  if (invalidErrors.length === 0) fail('malformed fixture must fail closed');
  const legalTransitions = new Set([
    'unowned->claimed',
    'claimed->active',
    'active->released',
    'claimed->expired',
    'active->expired',
    'expired->takeover',
  ]);
  const terminalRanks = { pending: 0, approved: 1, rejected: 1, terminal: 2 };
  for (const test of invariantFixture.cases ?? []) {
    let valid = true;
    if (test.state === 'active' && new Set(test.owners ?? []).size > 1) valid = false;
    if (test.idempotencyKeys && test.idempotencyKeys.length !== new Set(test.idempotencyKeys).size)
      valid = false;
    if (test.currentFencingToken !== undefined && test.fencingToken !== test.currentFencingToken)
      valid = false;
    if (test.from && test.to && !legalTransitions.has(`${test.from}->${test.to}`)) valid = false;
    if (
      test.fromDecision &&
      test.toDecision &&
      terminalRanks[test.toDecision] < terminalRanks[test.fromDecision]
    )
      valid = false;
    if (test.issue && (!test.issue.open || !test.issue.approved || test.issue.assigned))
      valid = false;
    if (valid !== test.valid)
      fail(`invariant fixture ${test.name} produced ${valid ? 'valid' : 'invalid'} unexpectedly`);
  }
}

function validateInventory() {
  if (inventory.inventoryVersion !== 'v1' || inventory.noShadowMode?.required !== true)
    fail('inventory must be v1 and shadow-mode gated');
  if (inventory.lockModel?.resourceKey !== 'crawler:v1:<resource-kind>:<repository>:<resource-id>')
    fail('lock resource key drifted');
  if (!inventory.lockModel?.rules?.includes('one active writer per resource'))
    fail('single-writer rule is missing');
  if (!inventory.lockModel?.rules?.includes('stale owners fail closed'))
    fail('stale-owner rule is missing');
  if (
    !inventory.lockModel?.rules?.includes(
      'repeated idempotency keys do not create a second mutation',
    )
  )
    fail('replay rule is missing');
  if (
    inventory.lockModel?.states?.includes('active') !== true ||
    inventory.lockModel?.states?.includes('expired') !== true
  )
    fail('ownership states are incomplete');
  if (JSON.stringify(inventory.lockModel).match(/\b(date|time|now)\b/i))
    fail('lock model must not use wall-clock values');
  if (inventory.workflows?.length !== 6) fail('exactly six required workflows must be inventoried');
  for (const entry of inventory.workflows ?? []) {
    const file = join(root, entry.file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      fail(`${entry.file} is missing`);
      continue;
    }
    const document = parse(source);
    const permissions = Object.entries(document.permissions ?? {}).map(
      ([key, value]) => `${key}: ${value}`,
    );
    for (const permission of entry.permissions ?? []) {
      if (!permissions.includes(permission) && !source.includes(`  ${permission}`))
        fail(`${entry.file} is missing permission ${permission}`);
    }
    if (!entry.owner || !entry.paths?.length || !entry.nonMutations?.length)
      fail(`${entry.file} needs owner, mutation paths, and non-mutations`);
    for (const path of entry.paths ?? []) {
      const lines = source.split(/\r?\n/);
      if (lines[path.line - 1]?.includes(path.anchor) !== true)
        fail(`${entry.file}:${path.line} does not match anchor ${path.anchor}`);
      if (!['invocation', 'decision'].includes(path.contract))
        fail(`${entry.file}:${path.kind} has no known contract`);
    }
  }
  const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const contractJob = ci.jobs?.['lifecycle-contracts'];
  const mergeGate = ci.jobs?.['merge-gate'];
  if (
    !contractJob ||
    contractJob.steps?.some((step) => step.run === 'npm run contracts:validate') !== true
  )
    fail('CI lifecycle-contracts job is not wired');
  const mergeNeeds = Array.isArray(mergeGate?.needs) ? mergeGate.needs : [];
  if (!mergeNeeds.includes('lifecycle-contracts'))
    fail('merge-gate does not require lifecycle-contracts');
}

validateFixtures();
validateInventory();
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    'Lifecycle contracts: v1 schemas, fixtures, invariants, and six workflow mutation paths validated.',
  );
}
