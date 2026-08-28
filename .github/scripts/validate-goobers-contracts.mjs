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

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "yaml"; // Requires npm install yaml

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

/**
 * Validate that a workflow's input spec matches the invocation schema
 */
function validateWorkflowInputs(workflowPath, contractSchema) {
  const content = fs.readFileSync(workflowPath, "utf8");
  const workflow = yaml.parse(content);

  if (!workflow.on || !workflow.on.workflow_dispatch) {
    // Not a dispatched workflow; skip
    return {
      path: workflowPath,
      status: "skipped",
      reason: "No workflow_dispatch trigger",
    };
  }

  const inputs = workflow.on.workflow_dispatch.inputs || {};
  const errors = [];

  // Validate required fields for known workflows
  const workflowName = path.basename(workflowPath, ".yml");
  if (
    workflowName.includes("ci-recovery") ||
    workflowName.includes("merge-train")
  ) {
    if (!inputs.pr_number) {
      errors.push("Missing required input: pr_number (PR-scoped operation)");
    }
    if (!inputs.operation) {
      errors.push("Missing required input: operation");
    }
  }

  // Validate expected_head_sha / expected_base_ref pair
  if (inputs.expected_head_sha && !inputs.expected_base_ref) {
    errors.push(
      "expected_head_sha set but expected_base_ref missing (required pair)"
    );
  }

  // Validate candidate-specific fields
  if (inputs.operation && inputs.operation.default === "validate-candidate") {
    const requiredCandidateFields = [
      "candidate_sha",
      "candidate_ref",
      "attestation_sha",
      "fingerprint",
    ];
    for (const field of requiredCandidateFields) {
      if (!inputs[field]) {
        errors.push(
          `Missing required input for validate-candidate: ${field}`
        );
      }
    }
  }

  return {
    path: workflowPath,
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    inputNames: Object.keys(inputs),
  };
}

/**
 * Main validation routine
 */
async function main() {
  console.log("=== Goobers Contract Schema Validation ===\n");

  const workflowDir = path.join(repoRoot, ".github/workflows");
  const requiredWorkflows = [
    "ci-recovery-router.yml",
    "ci-recovery.yml",
    "merge-train.yml",
    "merge-train-validate.yml",
    "goobers-run.yml",
    "goobers-validate.yml",
  ];

  let allPass = true;
  const results = [];

  for (const workflow of requiredWorkflows) {
    const workflowPath = path.join(workflowDir, workflow);

    if (!fs.existsSync(workflowPath)) {
      console.error(`❌ Missing required workflow: ${workflow}`);
      allPass = false;
      continue;
    }

    try {
      const result = validateWorkflowInputs(workflowPath, null);
      results.push(result);

      if (result.status === "skipped") {
        console.log(`⊘ ${workflow}: ${result.reason}`);
      } else if (result.status === "pass") {
        console.log(`✅ ${workflow}: All validations pass`);
      } else {
        console.log(
          `❌ ${workflow}: ${result.errors.length} validation error(s)`
        );
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

  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  console.log(`Passed: ${passed}/${requiredWorkflows.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);

  if (!allPass) {
    console.log("\n❌ Contract validation failed");
    process.exit(1);
  }

  console.log("\n✅ All contract validations pass");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
