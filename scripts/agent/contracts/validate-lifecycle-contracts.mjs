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

const schemas = {
  invocation: JSON.parse(
    readFileSync(join(contracts, 'lifecycle-invocation.v1.schema.json'), 'utf8'),
  ),
  decision: JSON.parse(readFileSync(join(contracts, 'lifecycle-decision.v1.schema.json'), 'utf8')),
};

function resolveRef(ref) {
  const [schemaId, fragment] = ref.split('#');
  const schema = Object.values(schemas).find((candidate) => candidate.$id === schemaId);
  if (!schema || !fragment?.startsWith('/'))
    throw new Error(`unresolvable schema reference: ${ref}`);
  return fragment
    .slice(1)
    .split('/')
    .reduce((value, key) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
}

function validateSchema(value, schema, path, issues) {
  if (schema.$ref) return validateSchema(value, resolveRef(schema.$ref), path, issues);
  if (schema.const !== undefined && value !== schema.const)
    issues.push(`${path} must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) issues.push(`${path} has an unsupported value`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) =>
      type === 'null'
        ? value === null
        : type === 'object'
          ? value && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer'
            ? Number.isInteger(value)
            : typeof value === type,
    );
    if (!matches) {
      issues.push(`${path} has an invalid type`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      issues.push(`${path} is malformed`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      issues.push(`${path} is too short`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum)
    issues.push(`${path} is below minimum`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? [])
      if (!(key in value)) issues.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (!(key in (schema.properties ?? {}))) {
        if (schema.additionalProperties === false) issues.push(`${path}.${key} is unknown`);
      } else validateSchema(child, schema.properties[key], `${path}.${key}`, issues);
    }
  }
}

function validateContract(value, path, schema) {
  const issues = [];
  validateSchema(value, schema, path, issues);
  errors.push(...issues);
  return issues.length === 0;
}

function validateIdentity(value, path) {
  const resource = value.resource;
  if (!resource || typeof resource !== 'object') return;
  const repository = resource.repository;
  const expectedKey = `crawler:v1:${resource.kind}:${repository}:${resource.id}`;
  if (repository !== repository.toLowerCase())
    errors.push(`${path}.resource.repository must be lowercase`);
  if (resource.key !== expectedKey)
    errors.push(`${path}.resource.key must match canonical resource identity`);
  const expectedPrefix = `v1:${expectedKey}:${value.operation}:`;
  if (!value.idempotencyKey.startsWith(expectedPrefix))
    errors.push(`${path}.idempotencyKey must bind to the canonical resource and operation`);
  const suffix = value.idempotencyKey.slice(expectedPrefix.length);
  const expectedGeneration = value.expected.headSha ?? value.expected.generation;
  if (suffix !== `${expectedGeneration}:1`)
    errors.push(`${path}.idempotencyKey must bind to expected head/generation and attempt`);
}

function validateFixtures() {
  const validInvocation = JSON.parse(
    readFileSync(join(contracts, 'fixtures/valid-invocation.json'), 'utf8'),
  );
  const validDecision = JSON.parse(
    readFileSync(join(contracts, 'fixtures/valid-decision.json'), 'utf8'),
  );
  const before = errors.length;
  validateContract(validInvocation, 'valid invocation', schemas.invocation);
  validateIdentity(validInvocation, 'valid invocation');
  validateContract(validDecision, 'valid decision', schemas.decision);
  validateIdentity(validDecision, 'valid decision');
  if (errors.length !== before) fail('valid fixtures must pass');
  const invalid = JSON.parse(
    readFileSync(join(contracts, 'fixtures/invalid-version.json'), 'utf8'),
  );
  const invalidBefore = errors.length;
  validateContract(invalid, 'invalid fixture', schemas.invocation);
  const invalidErrors = errors.splice(invalidBefore);
  if (invalidErrors.length === 0) fail('malformed fixture must fail closed');
  for (const name of ['invalid-nested-fields.json', 'invalid-resource-identity.json']) {
    const malformed = JSON.parse(readFileSync(join(contracts, 'fixtures', name), 'utf8'));
    const fixtureBefore = errors.length;
    validateContract(malformed, name, schemas.invocation);
    validateIdentity(malformed, name);
    const fixtureErrors = errors.splice(fixtureBefore);
    if (fixtureErrors.length === 0) fail(`${name} must fail closed`);
  }
  const legalTransitions = new Set([
    'unowned->claimed',
    'claimed->active',
    'active->released',
    'claimed->expired',
    'active->expired',
    'expired->takeover',
  ]);
  const terminalRanks = { pending: 0, approved: 1, rejected: 1, terminal: 2 };
  const validStates = new Set(['unowned', 'claimed', 'active', 'released', 'expired', 'takeover']);
  for (const test of invariantFixture.cases ?? []) {
    let valid = typeof test.name === 'string' && typeof test.valid === 'boolean';
    if ('owners' in test) {
      valid =
        valid &&
        Array.isArray(test.owners) &&
        test.owners.every((owner) => typeof owner === 'string') &&
        (test.state !== 'active' || test.owners.length === 1);
    }
    if ('state' in test)
      valid = valid && typeof test.state === 'string' && validStates.has(test.state);
    if ('idempotencyKeys' in test) {
      valid =
        valid &&
        Array.isArray(test.idempotencyKeys) &&
        test.idempotencyKeys.every((key) => typeof key === 'string') &&
        test.idempotencyKeys.length === new Set(test.idempotencyKeys).size;
    }
    if ('fencingToken' in test || 'currentFencingToken' in test) {
      valid =
        valid &&
        Number.isInteger(test.fencingToken) &&
        test.fencingToken >= 1 &&
        Number.isInteger(test.currentFencingToken) &&
        test.currentFencingToken >= 1 &&
        test.fencingToken === test.currentFencingToken;
    }
    if ('from' in test || 'to' in test)
      valid =
        valid &&
        typeof test.from === 'string' &&
        typeof test.to === 'string' &&
        legalTransitions.has(`${test.from}->${test.to}`);
    if ('fromDecision' in test || 'toDecision' in test)
      valid =
        valid &&
        Object.hasOwn(terminalRanks, test.fromDecision) &&
        Object.hasOwn(terminalRanks, test.toDecision) &&
        terminalRanks[test.toDecision] >= terminalRanks[test.fromDecision];
    if ('issue' in test) {
      valid =
        valid &&
        test.issue &&
        typeof test.issue.open === 'boolean' &&
        typeof test.issue.approved === 'boolean' &&
        typeof test.issue.assigned === 'boolean' &&
        test.issue.open &&
        test.issue.approved &&
        !test.issue.assigned;
    }
    if (valid !== test.valid)
      fail(
        `invariant fixture ${test.name ?? '<unnamed>'} produced ${valid ? 'valid' : 'invalid'} unexpectedly`,
      );
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
  for (const implementation of inventory.implementationPaths ?? []) {
    const file = join(root, implementation.file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      fail(`${implementation.file} implementation is missing`);
      continue;
    }
    if (!implementation.owner || !['invocation', 'decision'].includes(implementation.contract))
      fail(`${implementation.file} implementation has incomplete ownership`);
    const lines = source.split(/\r?\n/);
    for (const lineNumber of implementation.mutationLines ?? []) {
      if (!lines[lineNumber - 1]?.match(/request|removeLabel|dispatchWorkflow|gh |github\.rest\./))
        fail(`${implementation.file}:${lineNumber} is not a documented mutation call site`);
    }
  }
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
