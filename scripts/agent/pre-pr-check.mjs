#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gitOutput,
  normalizePath,
  npmExecutable,
  parseCsvList,
  runCommand,
} from './_helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const jsonMode = process.argv.includes('--json');
const requiredReviewAgents = ['rubber-duck', 'code-review'];
const allowedFeedbackStates = new Set(['addressed', 'no-findings']);

const personaRules = [
  { prefix: 'src/core/', personas: ['systems-engineer', 'qa-engineer'] },
  { prefix: 'src/shared/', personas: ['systems-engineer', 'qa-engineer'] },
  { prefix: 'src/game/ai/', personas: ['ai-content-engineer', 'story-designer', 'qa-engineer'] },
  { prefix: 'src/game/', personas: ['game-designer', 'qa-engineer'] },
  { prefix: 'src/engine/', personas: ['ux-designer', 'qa-engineer'] },
  { prefix: 'src/labs/', personas: ['ux-designer', 'qa-engineer'] },
  {
    prefix: 'scripts/agent/',
    personas: ['devops-engineer', 'qa-engineer'],
  },
  {
    prefix: '.github/workflows/',
    personas: ['devops-engineer', 'qa-engineer'],
  },
  {
    prefix: '.github/extensions/',
    personas: ['devops-engineer', 'qa-engineer'],
  },
  {
    prefix: 'docs/knowledge/game-design/',
    personas: ['game-designer', 'story-designer'],
  },
];

function isTrackedHandoff(filePath) {
  return (
    filePath.startsWith('docs/knowledge/handoffs/') &&
    path.basename(filePath) !== 'TEMPLATE.md'
  );
}

function selectLatestHandoff(handoffFiles) {
  return [...handoffFiles].sort().at(-1);
}

function deriveRequiredPersonas(changedFiles) {
  const personas = new Set();

  for (const file of changedFiles) {
    for (const rule of personaRules) {
      if (file.startsWith(rule.prefix)) {
        for (const persona of rule.personas) {
          personas.add(persona);
        }
      }
    }
  }

  return [...personas].sort();
}

function matchLine(content, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^-\\s*${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? '';
}

function normalizeBranchValue(value) {
  return value.replace(/`/g, '').trim();
}

function parseHandoff(content) {
  const personasConsulted = parseCsvList(matchLine(content, 'Personas consulted'));
  const reviewAgentsRun = parseCsvList(matchLine(content, 'Review agents run'));
  const feedbackState = matchLine(content, 'Feedback status').toLowerCase();
  const branch = normalizeBranchValue(matchLine(content, 'Branch'));

  return {
    personasConsulted,
    reviewAgentsRun,
    feedbackState,
    branch,
  };
}

async function ensureOriginMain() {
  const headResult = await runCommand(
    'git',
    ['rev-parse', '--verify', 'origin/main'],
    { cwd: repoRoot, capture: true, allowFailure: true },
  );
  if (headResult.code === 0) {
    return;
  }

  await runCommand('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: repoRoot });
}

async function collectMetadata() {
  await ensureOriginMain();

  const branch = await gitOutput(['branch', '--show-current'], repoRoot);
  const mergeBase = await gitOutput(['merge-base', 'HEAD', 'origin/main'], repoRoot);
  const changedFilesRaw = await gitOutput(
    ['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}..HEAD`],
    repoRoot,
  );
  const changedFiles = changedFilesRaw
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
  const requiredPersonas = deriveRequiredPersonas(changedFiles);
  const handoffFiles = changedFiles.filter(isTrackedHandoff);
  const latestHandoff = selectLatestHandoff(handoffFiles);
  const errors = [];

  let handoff = {
    personasConsulted: [],
    reviewAgentsRun: [],
    feedbackState: '',
    branch: '',
  };

  if (!latestHandoff) {
    errors.push(
      'Add a handoff file under docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md before creating a PR.',
    );
  } else {
    const handoffContent = await fs.readFile(path.join(repoRoot, latestHandoff), 'utf8');
    handoff = parseHandoff(handoffContent);

    if (handoff.branch !== branch) {
      errors.push(
        `Handoff branch metadata must match the current branch (${branch}).`,
      );
    }

    const missingPersonas = requiredPersonas.filter(
      (persona) => !handoff.personasConsulted.includes(persona),
    );
    if (missingPersonas.length > 0) {
      errors.push(
        `Latest handoff must list required personas consulted: ${missingPersonas.join(', ')}.`,
      );
    }

    const missingReviewAgents = requiredReviewAgents.filter(
      (agent) => !handoff.reviewAgentsRun.includes(agent),
    );
    if (missingReviewAgents.length > 0) {
      errors.push(
        `Latest handoff must record local review agents run: ${missingReviewAgents.join(', ')}.`,
      );
    }

    if (!allowedFeedbackStates.has(handoff.feedbackState)) {
      errors.push(
        'Latest handoff must set `Feedback status:` to `addressed` or `no-findings`.',
      );
    }
  }

  return {
    branch,
    changedFiles,
    requiredPersonas,
    handoffFiles,
    latestHandoff,
    handoff,
    errors,
  };
}

async function runVerification() {
  const verifyResult = await runCommand(
    npmExecutable,
    ['run', 'verify'],
    { cwd: repoRoot, capture: jsonMode, allowFailure: true },
  );
  const labGateResult = await runCommand(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'agent', 'lab-gate-check.mjs')],
    { cwd: repoRoot, capture: jsonMode, allowFailure: true },
  );

  return {
    verifyResult,
    labGateResult,
  };
}

function buildFailureSummary(metadata, verification) {
  const errors = [...metadata.errors];

  if (verification.verifyResult.code !== 0) {
    errors.push('`npm run verify` failed.');
  }
  if (verification.labGateResult.code !== 0) {
    errors.push('`npm run lab:gate` failed.');
  }

  return errors;
}

async function main() {
  const metadata = await collectMetadata();

  if (metadata.errors.length > 0) {
    const earlyResult = {
      ok: false,
      errors: metadata.errors,
      branch: metadata.branch,
      changedFiles: metadata.changedFiles,
      requiredPersonas: metadata.requiredPersonas,
      requiredReviewAgents,
      latestHandoff: metadata.latestHandoff,
      handoff: metadata.handoff,
      verifyExitCode: null,
      labGateExitCode: null,
      verifyOutput: '',
      labGateOutput: '',
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(earlyResult)}\n`);
      process.exitCode = 1;
      return;
    }

    console.log('❌ Pre-PR check failed before verification:');
    for (const error of metadata.errors) {
      console.log(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const verification = await runVerification();
  const errors = buildFailureSummary(metadata, verification);

  const result = {
    ok: errors.length === 0,
    errors,
    branch: metadata.branch,
    changedFiles: metadata.changedFiles,
    requiredPersonas: metadata.requiredPersonas,
    requiredReviewAgents,
    latestHandoff: metadata.latestHandoff,
    handoff: metadata.handoff,
    verifyExitCode: verification.verifyResult.code,
    labGateExitCode: verification.labGateResult.code,
    verifyOutput: jsonMode
      ? `${verification.verifyResult.stdout}${verification.verifyResult.stderr}`.trim()
      : '',
    labGateOutput: jsonMode
      ? `${verification.labGateResult.stdout}${verification.labGateResult.stderr}`.trim()
      : '',
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (!result.ok) {
    console.log('❌ Pre-PR check failed:');
    for (const error of result.errors) {
      console.log(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('✅ Pre-PR check passed.');
  console.log(`- Handoff: ${result.latestHandoff}`);
  console.log(`- Personas consulted: ${result.handoff.personasConsulted.join(', ') || 'none'}`);
  console.log(`- Review agents run: ${result.handoff.reviewAgentsRun.join(', ') || 'none'}`);
}

await main();
