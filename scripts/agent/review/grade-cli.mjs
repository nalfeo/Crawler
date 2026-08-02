#!/usr/bin/env node
/* global console */
// CLI for the independent grader (>=3🍎 `independent_grade` ledger stage).
//
//   # 1. Emit the grading packet (real diff + rubric) for an independent model.
//   npm run review:grade -- prompt <ledgerPath> [--base main] [--out files/grade-prompt.md]
//
//   # 2. Dispatch it yourself with the `task` tool, using a model that appears
//   #    in NEITHER the plan review nor the code review (the packet prints the
//   #    excluded list). Save the reply, then record it:
//   npm run review:grade -- record <ledgerPath> --model <graderModel>
//     --implementer <authoringModel> --file <replyPath>
//
// `record` recomputes the verdict from the scores/findings, writes the stage,
// and re-validates the whole ledger — exiting non-zero if the ledger is not
// complete for its tier, exactly like `review:ledger -- validate`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import { formatLedgerResult, validateLedger } from './ledger.mjs';
import {
  applyGradeToLedger,
  buildGradingPacket,
  collectDiff,
  formatGrade,
  parseGradeResponse,
  readLedger,
} from './grader.mjs';

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
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

function writeOut(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

function cmdPrompt(positional, flags) {
  const path = positional[0];
  if (!path) {
    console.error('prompt: usage: prompt <ledgerPath> [--base <ref>] [--out <file>]');
    return 1;
  }
  let ledger;
  try {
    ledger = readLedger(path);
  } catch (err) {
    console.error(`prompt: cannot read ledger ${path}: ${err.message}`);
    return 1;
  }
  let diff;
  try {
    diff = collectDiff({ baseRef: typeof flags.base === 'string' ? flags.base : 'main' });
  } catch (err) {
    console.error(`prompt: cannot collect the diff: ${err.message}`);
    return 1;
  }
  const packet = buildGradingPacket({ ledger, diff });

  if (typeof flags.out === 'string') {
    writeOut(flags.out, `${packet.prompt}\n`);
    console.log(`Wrote grading packet to ${flags.out}`);
  } else {
    console.log(packet.prompt);
  }
  console.error(`\n[grader] head_sha: ${packet.headSha}`);
  console.error(
    `[grader] models that must NOT grade this change: ${
      packet.excludedModels.length > 0 ? packet.excludedModels.join(', ') : '(none recorded yet)'
    }`,
  );
  return 0;
}

function cmdRecord(positional, flags) {
  const path = positional[0];
  if (!path) {
    console.error(
      "record: usage: record <ledgerPath> --model <graderModel> --implementer <authoringModel> (--file <replyPath> | --json '<reply>') [--head-sha <sha>]",
    );
    return 1;
  }
  if (typeof flags.model !== 'string') {
    console.error('record: --model <graderModel> is required (must differ from every reviewer)');
    return 1;
  }
  if (typeof flags.implementer !== 'string') {
    console.error(
      'record: --implementer <authoringModel> is required — the grader must be independent of the model that AUTHORED the change, not just of the reviewers',
    );
    return 1;
  }
  let reply;
  if (typeof flags.file === 'string') {
    try {
      reply = readFileSync(flags.file, 'utf-8');
    } catch (err) {
      console.error(`record: cannot read ${flags.file}: ${err.message}`);
      return 1;
    }
  } else if (typeof flags.json === 'string') {
    reply = flags.json;
  } else {
    console.error("record: one of --file <replyPath> or --json '<reply>' is required");
    return 1;
  }

  let ledger;
  try {
    ledger = readLedger(path);
  } catch (err) {
    console.error(`record: cannot read ledger ${path}: ${err.message}`);
    return 1;
  }

  let headSha = typeof flags['head-sha'] === 'string' ? flags['head-sha'] : null;
  if (!headSha) {
    try {
      headSha = collectDiff({
        baseRef: typeof flags.base === 'string' ? flags.base : 'main',
      }).headSha;
    } catch (err) {
      console.error(
        `record: cannot resolve the graded sha (${err.message}); pass --head-sha <sha> explicitly`,
      );
      return 1;
    }
  }

  let parsed;
  try {
    parsed = parseGradeResponse(reply, {
      graderModel: flags.model,
      implementerModel: flags.implementer,
      headSha,
    });
  } catch (err) {
    console.error(`record: ${err.message}`);
    return 1;
  }

  const updated = applyGradeToLedger(ledger, parsed.stage);
  writeOut(path, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(formatGrade(parsed.stage));
  if (parsed.verdictOverridden) {
    console.log(
      "note: verdict was recomputed to 'fail' from the scores/findings — a grade cannot pass with a criterion below 3 or a blocker finding.",
    );
  }
  for (const f of parsed.findings) {
    console.log(`   • [${f.severity ?? '?'}] ${f.file ?? '(no file)'}: ${f.detail ?? ''}`);
  }

  const result = validateLedger(updated);
  console.log(formatLedgerResult(result, path));
  return result.ok ? 0 : 1;
}

function main() {
  const [, , sub, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  switch (sub) {
    case 'prompt':
      return cmdPrompt(positional, flags);
    case 'record':
      return cmdRecord(positional, flags);
    default:
      console.error('Usage: review:grade <prompt|record> <ledgerPath> [...]');
      console.error('  prompt  <ledgerPath> [--base <ref>] [--out <file>]');
      console.error(
        "  record  <ledgerPath> --model <graderModel> --implementer <authoringModel> (--file <replyPath> | --json '<reply>') [--head-sha <sha>]",
      );
      return 1;
  }
}

process.exit(main());
