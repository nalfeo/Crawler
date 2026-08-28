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
import { fileURLToPath } from 'url';
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

function invocationSemanticErrors(payload) {
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

function outputSemanticErrors(payload) {
  const errors = [];
  const status = payload?.status;
  const hasError = payload?.error !== undefined && payload?.error !== null;
  if ((status === 'failure' || status === 'blocked') && !hasError) {
    errors.push('error is required when status is failure or blocked');
  }
  if ((status === 'success' || status === 'no-work') && hasError) {
    errors.push('error must be null or omitted when status is success or no-work');
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
        pr_number: 42,
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
      name: 'goobers-run workflow payload',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
        workflowName: 'goobers-run',
        operation: 'run-feature-pr',
        issue_number: 3840,
        trigger: 'workflow_dispatch',
      },
    },
    {
      name: 'unknown invocation contract version fails closed',
      shouldPass: false,
      payload: {
        contractVersion: 'v2',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: 42,
      },
    },
    {
      name: 'expected_head_sha requires expected_base_ref',
      shouldPass: false,
      payload: {
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: 42,
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
        workflowName: 'goobers-run',
        operation: 'run-feature-pr',
        pr_number: 42,
      },
    },
  ];
}

function outputFixtures() {
  return [
    {
      name: 'success output payload',
      shouldPass: true,
      payload: {
        contractVersion: 'v1',
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
        status: 'success',
        outputs: {
          appleEstimate: 6,
        },
        summary: 'Invalid apple estimate',
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

  for (const result of [...invocationResults, ...outputResults]) {
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
  const fixturePassed = [...invocationResults, ...outputResults].filter(
    (r) => r.status === 'pass',
  ).length;
  const fixtureTotal = invocationResults.length + outputResults.length;

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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
