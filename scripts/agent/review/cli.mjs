#!/usr/bin/env node
/* global console */
// CLI for the apple-scaled review ledger. Thin wrapper around ledger.mjs.
//
//   npm run review:ledger -- init --apples 4 --slug my-change --title "My change"
//   npm run review:ledger -- stage <path> code_review --json '{"clean":true,"rounds":[...]}'
//   npm run review:ledger -- validate [path]
//
// `validate` exits non-zero when the ledger is incomplete for its declared
// apple tier — the same check the pr-review-ledger guard enforces before PR.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import {
  LEDGER_DIR,
  LEDGER_PATH_RE,
  SCHEMA_VERSION,
  STAGE_NAMES,
  DATE_RE,
  SLUG_RE,
  requiredStagesForApples,
  validateLedgerFile,
  formatLedgerResult,
} from './ledger.mjs';

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        // --flag=value form: lets values legitimately begin with '--'.
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function scaffoldStage(name, apples = null) {
  switch (name) {
    case 'plan_review': {
      // Base fields (every plan_review). At 3🍎+ `plan_divergence` is required;
      // at 4-5🍎 the review must be ADVERSARIAL (ADR 0051), so scaffold those
      // fields with invalid placeholders to force the author to fill them in
      // (same convention as reviewer_model: '').
      const stage = {
        completed: false,
        reviewer_model: '',
        concerns_count: 0,
        resolved_count: 0,
      };
      if (Number.isInteger(apples) && apples >= 4) {
        stage.adversarial = false;
        stage.alternatives_considered = 0;
      }
      if (Number.isInteger(apples) && apples >= 3) {
        stage.plan_divergence = '';
      }
      stage.notes = '';
      return stage;
    }
    case 'dual_plan_synthesis':
      // Legacy/optional stage (ADR 0051): no longer scaffolded by `init` (it is
      // not required at any tier), but still supported via `stage` for anyone
      // intentionally recording it on a ledger.
      return { completed: false, plan_models: ['', ''], judge_model: '', notes: '' };
    case 'code_review':
      return { clean: false, rounds: [] };
    case 'multi_model_review':
      return { clean: false, adjudicator_model: '', rounds: [] };
    case 'independent_grade':
      // Scaffolded with invalid placeholders on purpose: this stage must be
      // filled in by `npm run review:grade -- record`, never hand-written from
      // the author's own opinion of the change.
      return {
        completed: false,
        grader_model: '',
        implementer_model: '',
        head_sha: '',
        criteria: {},
        verdict: '',
        findings_count: 0,
      };
    default:
      return {};
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
}

function cmdInit(flags) {
  if (typeof flags.apples !== 'string') {
    console.error('init: --apples requires a value (integer 1..5)');
    return 1;
  }
  const apples = Number(flags.apples);
  if (!Number.isInteger(apples) || apples < 1 || apples > 5) {
    console.error('init: --apples must be an integer 1..5');
    return 1;
  }
  const slug = typeof flags.slug === 'string' ? flags.slug : '';
  if (!SLUG_RE.test(slug)) {
    console.error('init: --slug must be kebab-case (e.g. improve-local-harness)');
    return 1;
  }
  const title = typeof flags.title === 'string' ? flags.title : '';
  if (!title.trim()) {
    console.error('init: --title is required');
    return 1;
  }
  let date;
  if (flags.date === undefined) {
    date = new Date().toISOString().slice(0, 10);
  } else if (typeof flags.date === 'string' && DATE_RE.test(flags.date)) {
    date = flags.date;
  } else {
    console.error('init: --date must be a YYYY-MM-DD string');
    return 1;
  }
  const required = requiredStagesForApples(apples);
  const stages = {};
  for (const s of required) stages[s] = scaffoldStage(s, apples);
  const ledger = {
    schema_version: SCHEMA_VERSION,
    date,
    session_slug: slug,
    task_title: title,
    estimated_apples: apples,
    stages,
  };
  const path = join(LEDGER_DIR, `${date}-${slug}.review-ledger.json`);
  if (existsSync(path) && !flags.force) {
    console.error(`init: ${path} already exists (use --force to overwrite)`);
    return 1;
  }
  writeJson(path, ledger);
  const stagesLabel = required.length > 0 ? required.join(', ') : '(none)';
  console.log(`Created ${path} (apples=${apples}, required stages: ${stagesLabel})`);
  return 0;
}

function cmdStage(positional, flags) {
  const [path, stageName] = positional;
  if (!path || !stageName) {
    console.error("stage: usage: stage <ledgerPath> <stageName> --json '{...}'");
    return 1;
  }
  if (!STAGE_NAMES.includes(stageName)) {
    console.error(`stage: unknown stage '${stageName}'. Valid stages: ${STAGE_NAMES.join(', ')}`);
    return 1;
  }
  if (typeof flags.json !== 'string') {
    console.error("stage: --json '<patch>' is required");
    return 1;
  }
  let patch;
  try {
    patch = JSON.parse(flags.json);
  } catch (err) {
    console.error(`stage: --json is not valid JSON: ${err.message}`);
    return 1;
  }
  if (!existsSync(path)) {
    console.error(`stage: ${path} does not exist (run init first)`);
    return 1;
  }
  const ledger = JSON.parse(readFileSync(path, 'utf-8'));
  ledger.stages = ledger.stages || {};
  ledger.stages[stageName] = { ...(ledger.stages[stageName] || {}), ...patch };
  writeJson(path, ledger);
  console.log(`Updated ${stageName} in ${path}`);
  return 0;
}

function discoverNewest() {
  if (!existsSync(LEDGER_DIR)) return null;
  const matches = readdirSync(LEDGER_DIR)
    .map((f) => `${LEDGER_DIR}/${f}`)
    .filter((p) => LEDGER_PATH_RE.test(p))
    .sort();
  return matches.length ? matches[matches.length - 1] : null;
}

function cmdValidate(positional) {
  const path = positional[0] || discoverNewest();
  if (!path) {
    console.error(`validate: no ledger path given and none found in ${LEDGER_DIR}/`);
    return 1;
  }
  const result = validateLedgerFile(path);
  console.log(formatLedgerResult(result, path));
  return result.ok ? 0 : 1;
}

function main() {
  const [, , sub, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  switch (sub) {
    case 'init':
      return cmdInit(flags);
    case 'stage':
      return cmdStage(positional, flags);
    case 'validate':
      return cmdValidate(positional);
    default:
      console.error('Usage: review:ledger <init|stage|validate> [...]');
      console.error('  init     --apples N --slug S --title T [--date YYYY-MM-DD] [--force]');
      console.error("  stage    <path> <stageName> --json '{...}'");
      console.error('  validate [path]');
      console.error('');
      console.error('The >=3🍎 independent_grade stage is filled in by the grader CLI:');
      console.error('  npm run review:grade -- prompt <path>');
      console.error(
        '  npm run review:grade -- record <path> --model <graderModel> --implementer <authoringModel> --file <reply> --head-sha <packetHeadSha>',
      );
      return 1;
  }
}

process.exit(main());
