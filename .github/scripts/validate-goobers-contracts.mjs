#!/usr/bin/env node

/**
 * Validate Goobers Contract Schemas
 *
 * Checks that all CI Recovery, Merge Train, and Goobers workflows
 * conform to contractVersion v1 schemas.
 *
 * Usage: node .github/scripts/validate-goobers-contracts.mjs
 * Exit code: 0 on all validations pass, non-zero on failure
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'yaml';
import { invocationV1, outputV1 } from './validate-goobers-contracts-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const REQUIRED_WORKFLOWS = [
  'ci-recovery-router.yml',
  'ci-recovery.yml',
  'merge-train.yml',
  'merge-train-validate.yml',
  'goobers-run.yml',
  'goobers-validate.yml',
];

const REQUIRED_DISPATCH_INPUTS = new Map([
  [
    'ci-recovery.yml',
    ['operation', 'pr_number', 'trigger', 'expected_head_sha', 'expected_base_ref', 'lease_id'],
  ],
  [
    'merge-train-validate.yml',
    ['candidate_sha', 'candidate_ref', 'attestation_sha', 'fingerprint', 'pr_numbers'],
  ],
  ['goobers-run.yml', ['goobers_version', 'workflow', 'issue_number', 'abandon_existing']],
  ['goobers-validate.yml', ['goobers_version']],
]);

function parseWorkflow(content) {
  const parsed = yaml.parse(content);
  const on = parsed?.on ?? parsed?.['on'] ?? parsed?.true;
  return { ...parsed, on };
}

function formatAjvErrors(errors = []) {
  return errors.map((err) => {
    const pointer = err.instancePath || err.dataPath || '/';
    return `${pointer} ${err.message}`.trim();
  });
}

export function invocationSemanticErrors(payload) {
  const errors = [];
  const operation = payload?.operation;
  const hasPrNumber = payload?.pr_number !== undefined && payload?.pr_number !== null;
  const prScopedOperations = new Set([
    'reconcile',
    'lease-acquire',
    'lease-heartbeat',
    'lease-release',
  ]);

  if (
    String(payload?.expected_head_sha || '').trim() &&
    !String(payload?.expected_base_ref || '').trim()
  ) {
    errors.push('expected_base_ref is required when expected_head_sha is set');
  }
  if (operation === 'validate-candidate') {
    for (const field of ['candidate_sha', 'candidate_ref', 'attestation_sha', 'fingerprint']) {
      if (!String(payload?.[field] || '').trim()) {
        errors.push(`${field} is required for validate-candidate`);
      }
    }
  }
  if (prScopedOperations.has(operation) && !hasPrNumber) {
    errors.push(`pr_number is required for operation=${operation}`);
  }
  if (!prScopedOperations.has(operation) && hasPrNumber) {
    errors.push(`pr_number is forbidden for operation=${operation}`);
  }

  return errors;
}

const PLANNING_TASK = 'plan';
const GATE_TASKS = new Set(['plan', 'local-gate', 'pr-opened-gate', 'review']);

export function outputSemanticErrors(payload) {
  const errors = [];
  const status = payload?.status;
  const task = payload?.task;
  const outputs = payload?.outputs || {};
  const hasError = payload?.error !== undefined && payload?.error !== null;
  if ((status === 'failure' || status === 'blocked') && !hasError) {
    errors.push('error is required when status is failure or blocked');
  }
  if ((status === 'success' || status === 'no-work') && hasError) {
    errors.push('error must be null or omitted when status is success or no-work');
  }
  if (outputs.verdict !== undefined && outputs.verdict !== null && task !== PLANNING_TASK) {
    errors.push(`outputs.verdict is only valid when task='${PLANNING_TASK}' (got task=${task})`);
  }
  if (
    outputs.appleEstimate !== undefined &&
    outputs.appleEstimate !== null &&
    task !== PLANNING_TASK
  ) {
    errors.push(
      `outputs.appleEstimate is only valid when task='${PLANNING_TASK}' (got task=${task})`,
    );
  }
  if (outputs.hardGate !== undefined && outputs.hardGate !== null && !GATE_TASKS.has(task)) {
    errors.push(
      `outputs.hardGate is only valid for gate-bearing tasks (${[...GATE_TASKS].join(', ')}); got task=${task}`,
    );
  }
  return errors;
}

function validateWorkflowInputs(workflowPath) {
  const content = fs.readFileSync(workflowPath, 'utf8');
  const workflow = parseWorkflow(content);

  if (!workflow.on || !Object.prototype.hasOwnProperty.call(workflow.on, 'workflow_dispatch')) {
    return {
      path: workflowPath,
      status: 'fail',
      errors: ['Missing workflow_dispatch trigger'],
    };
  }

  const dispatchConfig = workflow.on.workflow_dispatch || {};
  const inputs = dispatchConfig.inputs || {};
  const errors = [];
  const workflowName = path.basename(workflowPath);
  const requiredInputs = REQUIRED_DISPATCH_INPUTS.get(workflowName) || [];
  for (const inputName of requiredInputs) {
    if (!Object.prototype.hasOwnProperty.call(inputs, inputName)) {
      errors.push(`Missing required workflow_dispatch input: ${inputName}`);
    }
  }
  return {
    path: workflowPath,
    status: errors.length === 0 ? 'pass' : 'fail',
    errors,
    inputNames: Object.keys(inputs),
  };
}

function validateFixtures(validator, fixtures, semanticValidator = null) {
  const results = [];
  for (const fixture of fixtures) {
    const schemaValid = validator(fixture.payload);
    const schemaErrors = schemaValid ? [] : formatAjvErrors(validator.errors || []);
    const semanticErrors = semanticValidator ? semanticValidator(fixture.payload) : [];
    const passed = schemaValid && semanticErrors.length === 0;
    if (fixture.shouldPass !== passed) {
      results.push({
        status: 'fail',
        name: fixture.name,
        errors: [
          `Expected ${fixture.shouldPass ? 'valid' : 'invalid'} fixture but got ${
            passed ? 'valid' : 'invalid'
          }`,
          ...schemaErrors,
          ...semanticErrors,
        ],
      });
    } else {
      results.push({ status: 'pass', name: fixture.name, errors: [] });
    }
  }
  return results;
}

function invocationFixtures() {
  return [
    {
      name: 'ci-recovery reconcile payload',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '42',
        trigger: 'workflow_dispatch',
      },
    },
    {
      name: 'merge-train validate-candidate payload',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
        workflowName: 'merge-train-validate',
        operation: 'validate-candidate',
        candidate_sha: 'a'.repeat(40),
        candidate_ref: 'refs/merge-train-candidates/candidate-1',
        attestation_sha: 'b'.repeat(40),
        fingerprint: 'gen-5',
        pr_numbers: '42,43',
      },
    },
    {
      // Real trigger strings minted by ci-recovery/router.mjs's
      // recoveryTriggerForPr() and merge-train/reconcile.mjs's
      // dispatchRecoveryGated() calls (e.g. 'merge-train-noop',
      // 'merge-train-cumulative-conflict:41', 'issue_comment:sweep') are
      // free-form business-reason strings, not GitHub event names; the
      // schema must accept them rather than a closed GH-event enum.
      name: 'business-reason trigger strings are accepted, not just GH event names',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
        workflowName: 'merge-train',
        operation: 'reconcile',
        pr_number: '42',
        trigger: 'merge-train-cumulative-conflict:41',
      },
    },
    {
      name: 'unknown invocation contract version fails closed',
      shouldPass: false,
      payload: {
        contractVersion: 'v2',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '42',
      },
    },
    {
      name: 'expected_head_sha requires expected_base_ref',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '42',
        expected_head_sha: 'abc123',
      },
    },
    {
      name: 'validate-candidate requires all candidate fields',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        workflowName: 'merge-train-validate',
        operation: 'validate-candidate',
        candidate_sha: 'a'.repeat(40),
      },
    },
    {
      name: 'batch operation forbids pr_number',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        workflowName: 'merge-train-validate',
        operation: 'validate-candidate',
        candidate_sha: 'a'.repeat(40),
        candidate_ref: 'refs/merge-train-candidates/candidate-1',
        attestation_sha: 'b'.repeat(40),
        fingerprint: 'gen-5',
        pr_numbers: '42,43',
        pr_number: '42',
      },
    },
    {
      // GitHub Actions never sends numeric JSON for workflow_dispatch inputs;
      // a producer that regresses to sending a native number must fail closed.
      name: 'non-string pr_number fails closed (GH Actions inputs are always strings)',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: 42,
        trigger: 'workflow_dispatch',
      },
    },
  ];
}

/**
 * Derive the real invocation envelopes actually produced by the dispatch
 * helpers in reconcile-lib.mjs (CI Recovery + Merge Train). This validates
 * the contract against the genuine wire payload the production code
 * constructs -- not only hand-authored fixtures above -- so a producer
 * regression (missing/renamed input, wrong JSON type, unlisted operation)
 * fails this gate.
 */
async function realProducerInvocations() {
  const reconcileLibPath = path.join(repoRoot, '.github/scripts/merge-train/reconcile-lib.mjs');
  const { dispatchRecoveryWorkflow, dispatchValidationWorkflow } = await import(
    pathToFileURL(reconcileLibPath).href
  );

  const results = [];
  let capturedRecoveryBody;
  await dispatchRecoveryWorkflow({
    request: async (_token, _endpoint, options) => {
      capturedRecoveryBody = options.body;
      return { data: {} };
    },
    token: 'actions-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    prNumber: 42,
    trigger: 'merge-train-noop',
  });
  results.push({
    name: 'real dispatchRecoveryWorkflow() invocation envelope',
    // dispatchRecoveryWorkflow's `inputs` are the literal wire payload; the
    // contract envelope fields (contractVersion/workflowName/operation) are
    // supplied by the ci-recovery.yml consumer side, not sent over the wire,
    // so they are attributed here to validate the real `inputs` shape.
    payload: {
      contractVersion: 'v1',
      workflowName: 'ci-recovery',
      operation: capturedRecoveryBody.inputs.operation,
      pr_number: capturedRecoveryBody.inputs.pr_number,
      trigger: capturedRecoveryBody.inputs.trigger,
      lease_id: capturedRecoveryBody.inputs.lease_id,
    },
  });

  let capturedValidationBody;
  await dispatchValidationWorkflow({
    request: async (_token, _endpoint, options) => {
      capturedValidationBody = options.body;
      return { data: {} };
    },
    token: 'actions-token',
    owner: 'nalfeo',
    repo: 'Crawler',
    sha: 'b'.repeat(40),
    refName: 'refs/merge-train-candidates/candidate-1',
    attestationSha: 'a'.repeat(40),
    fingerprint: 'gen-5',
    entries: [{ number: 42 }, { number: 43 }],
  });
  results.push({
    name: 'real dispatchValidationWorkflow() invocation envelope',
    payload: {
      contractVersion: 'v1',
      workflowName: 'merge-train-validate',
      operation: 'validate-candidate',
      candidate_sha: capturedValidationBody.inputs.candidate_sha,
      candidate_ref: capturedValidationBody.inputs.candidate_ref,
      attestation_sha: capturedValidationBody.inputs.attestation_sha,
      fingerprint: capturedValidationBody.inputs.fingerprint,
      pr_numbers: capturedValidationBody.inputs.pr_numbers,
    },
  });

  // CI Recovery Router (ci-recovery-router.yml) does not go through
  // reconcile-lib.mjs at all -- it builds its own workflow_dispatch bodies.
  // Import its own pure body-builder helpers (the same functions the real
  // reaper/normal dispatch loops call) so this validates the genuine
  // router-produced payload shape too, not just the merge-train/CI-Recovery
  // helpers above.
  const routerPath = path.join(repoRoot, '.github/scripts/ci-recovery/router.mjs');
  const { buildReaperDispatchBody, buildRouterDispatchBody } = await import(
    pathToFileURL(routerPath).href
  );
  const fakePayload = { repository: { default_branch: 'main' } };

  const reaperBody = buildReaperDispatchBody(42, 'lease-reaper', fakePayload);
  results.push({
    name: 'real CI Recovery Router buildReaperDispatchBody() invocation envelope',
    payload: {
      contractVersion: 'v1',
      workflowName: 'ci-recovery',
      operation: reaperBody.inputs.operation,
      pr_number: reaperBody.inputs.pr_number,
      trigger: reaperBody.inputs.trigger,
      lease_id: reaperBody.inputs.lease_id,
    },
  });

  const routerBody = buildRouterDispatchBody(
    43,
    'merge-train-cumulative-conflict:41',
    fakePayload,
    {
      expectedHeadSha: 'c'.repeat(40),
      expectedBaseRef: 'main',
    },
  );
  results.push({
    name: 'real CI Recovery Router buildRouterDispatchBody() invocation envelope',
    payload: {
      contractVersion: 'v1',
      workflowName: 'ci-recovery',
      operation: routerBody.inputs.operation,
      pr_number: routerBody.inputs.pr_number,
      trigger: routerBody.inputs.trigger,
      expected_head_sha: routerBody.inputs.expected_head_sha,
      expected_base_ref: routerBody.inputs.expected_base_ref,
      lease_id: routerBody.inputs.lease_id,
    },
  });

  return results.map((entry) => ({ ...entry, shouldPass: true }));
}

function outputFixtures() {
  return [
    {
      name: 'success output payload',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
        task: 'plan',
        status: 'success',
        outputs: {
          verdict: 'recommended',
          appleEstimate: 3,
          hardGate: 'all checks green',
          blockedBy: null,
        },
        summary: 'Completed successfully',
      },
    },
    {
      name: 'blocked output payload',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
        task: 'plan',
        status: 'blocked',
        outputs: {
          verdict: null,
          appleEstimate: null,
          hardGate: 'CI contract gate',
          blockedBy: '441,442',
        },
        summary: 'Blocked by upstream issues',
        error: {
          code: 'REQUIREMENTS_MISMATCH',
          message: 'Blocked by upstream requirements',
        },
      },
    },
    {
      name: 'failure output requires error object',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        task: 'implement',
        status: 'failure',
        outputs: {},
        summary: 'Failed',
      },
    },
    {
      name: 'success output forbids non-null error object',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: {},
        summary: 'Done',
        error: {
          code: 'TEST_FAILURE',
          message: 'unexpected',
        },
      },
    },
    {
      name: 'apple estimate bounds enforced',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        task: 'plan',
        status: 'success',
        outputs: {
          appleEstimate: 6,
        },
        summary: 'Invalid apple estimate',
      },
    },
    {
      // The exact scenario the reviewer flagged: a non-planning task output
      // must not be able to smuggle a verdict/appleEstimate through.
      name: 'non-planning task cannot carry a verdict or appleEstimate',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: {
          verdict: 'recommended',
          appleEstimate: 3,
        },
        summary: 'Implementation finished',
      },
    },
    {
      name: 'hardGate only valid on gate-bearing tasks',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        task: 'push-branch',
        status: 'success',
        outputs: {
          hardGate: 'push must succeed',
        },
        summary: 'Pushed branch',
      },
    },
  ];
}

/**
 * Main validation routine
 */
async function main() {
  console.log('=== Goobers Contract Schema Validation ===\n');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateInvocation = ajv.compile(invocationV1);
  const validateOutput = ajv.compile(outputV1);

  const workflowDir = path.join(repoRoot, '.github/workflows');
  let allPass = true;
  const workflowResults = [];

  for (const workflow of REQUIRED_WORKFLOWS) {
    const workflowPath = path.join(workflowDir, workflow);

    if (!fs.existsSync(workflowPath)) {
      console.error(`❌ Missing required workflow: ${workflow}`);
      allPass = false;
      continue;
    }

    try {
      const result = validateWorkflowInputs(workflowPath);
      workflowResults.push(result);

      if (result.status === 'pass') {
        console.log(`✅ ${workflow}: All validations pass`);
      } else {
        console.log(`❌ ${workflow}: ${result.errors.length} validation error(s)`);
        for (const err of result.errors) {
          console.log(`   - ${err}`);
        }
        allPass = false;
      }
    } catch (err) {
      console.error(`❌ ${workflow}: Failed to parse (${err.message})`);
      allPass = false;
    }
  }

  const invocationResults = validateFixtures(
    validateInvocation,
    invocationFixtures(),
    invocationSemanticErrors,
  );
  const outputResults = validateFixtures(validateOutput, outputFixtures(), outputSemanticErrors);
  const producerResults = validateFixtures(
    validateInvocation,
    await realProducerInvocations(),
    invocationSemanticErrors,
  );

  for (const result of [...invocationResults, ...outputResults, ...producerResults]) {
    if (result.status === 'pass') {
      console.log(`✅ fixture: ${result.name}`);
      continue;
    }
    allPass = false;
    console.log(`❌ fixture: ${result.name}`);
    for (const error of result.errors) {
      console.log(`   - ${error}`);
    }
  }

  console.log('\n=== Summary ===');
  const passed = workflowResults.filter((r) => r.status === 'pass').length;
  const failed = workflowResults.filter((r) => r.status === 'fail').length;
  const fixturePassed = [...invocationResults, ...outputResults, ...producerResults].filter(
    (r) => r.status === 'pass',
  ).length;
  const fixtureTotal = invocationResults.length + outputResults.length + producerResults.length;

  console.log(`Workflow schemas passed: ${passed}/${REQUIRED_WORKFLOWS.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Fixture validations passed: ${fixturePassed}/${fixtureTotal}`);

  if (!allPass) {
    console.log('\n❌ Contract validation failed');
    process.exit(1);
  }

  console.log('\n✅ All contract validations pass');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
