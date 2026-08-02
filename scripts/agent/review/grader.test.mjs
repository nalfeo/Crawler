import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GRADE_CRITERIA } from './ledger.mjs';
import {
  applyGradeToLedger,
  buildGradingPacket,
  collectDiff,
  extractJson,
  formatGrade,
  parseGradeResponse,
  resolveBase,
} from './grader.mjs';

const HEAD = 'b'.repeat(40);
const GRADER = 'independent-grader-model';

function scores(value = 4, overrides = {}) {
  const out = {};
  for (const c of GRADE_CRITERIA) out[c] = value;
  return { ...out, ...overrides };
}

function reply(body) {
  return `Here is my grade.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

function ledgerFixture() {
  return {
    schema_version: 'review-ledger/v2',
    estimated_apples: 3,
    task_title: 'Do the thing',
    stages: {
      plan_review: { completed: true, reviewer_model: 'gpt-5.4' },
      code_review: { clean: true, rounds: [{ models: ['claude-opus-4.8'] }] },
    },
  };
}

// ---------------------------------------------------------------------------
// resolveBase / collectDiff (injectable git)
// ---------------------------------------------------------------------------

test('resolveBase falls back from main to origin/main', () => {
  const seen = [];
  const runGit = (_cwd, args) => {
    seen.push(args.join(' '));
    if (args[1] === 'HEAD' && args[2] === 'main') throw new Error('unknown revision');
    return 'basesha\n';
  };
  assert.equal(resolveBase({ runGit }), 'basesha');
  assert.deepEqual(seen, ['merge-base HEAD main', 'merge-base HEAD origin/main']);
});

test('resolveBase throws a descriptive error when no candidate resolves', () => {
  const runGit = () => {
    throw new Error('nope');
  };
  assert.throws(() => resolveBase({ runGit }), /could not resolve a merge-base against 'main'/);
});

test('collectDiff returns the real file list, head sha, and diff text', () => {
  const runGit = (_cwd, args) => {
    if (args[0] === 'merge-base') return 'base123\n';
    if (args[0] === 'rev-parse') return `${HEAD}\n`;
    if (args[0] === 'diff' && args[1] === '--name-only') return 'src/a.ts\nsrc/b.ts\n\n';
    if (args[0] === 'diff') return 'diff --git a/src/a.ts b/src/a.ts\n+added\n';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const d = collectDiff({ runGit });
  assert.equal(d.baseSha, 'base123');
  assert.equal(d.headSha, HEAD);
  assert.deepEqual(d.files, ['src/a.ts', 'src/b.ts']);
  assert.match(d.diff, /\+added/);
  assert.equal(d.truncated, false);
});

test('collectDiff truncates an oversized diff and flags it', () => {
  const runGit = (_cwd, args) => {
    if (args[0] === 'merge-base') return 'base123\n';
    if (args[0] === 'rev-parse') return `${HEAD}\n`;
    if (args[1] === '--name-only') return 'src/a.ts\n';
    return 'x'.repeat(500);
  };
  const d = collectDiff({ runGit, diffCharLimit: 100 });
  assert.equal(d.truncated, true);
  assert.match(d.diff, /diff truncated/);
});

// ---------------------------------------------------------------------------
// buildGradingPacket
// ---------------------------------------------------------------------------

test('buildGradingPacket excludes every model that already reviewed the change', () => {
  const packet = buildGradingPacket({
    ledger: ledgerFixture(),
    diff: { files: ['src/a.ts'], diff: '+x', headSha: HEAD, baseSha: 'base', truncated: false },
  });
  assert.deepEqual(packet.excludedModels.sort(), ['claude-opus-4.8', 'gpt-5.4']);
  assert.equal(packet.headSha, HEAD);
});

test('buildGradingPacket embeds the real diff, the file list, and every criterion', () => {
  const packet = buildGradingPacket({
    ledger: ledgerFixture(),
    diff: {
      files: ['src/a.ts'],
      diff: 'diff --git a/src/a.ts',
      headSha: HEAD,
      baseSha: 'base',
      truncated: false,
    },
  });
  assert.match(packet.prompt, /diff --git a\/src\/a\.ts/);
  assert.match(packet.prompt, /• src\/a\.ts/);
  assert.match(packet.prompt, /Do the thing/);
  for (const c of GRADE_CRITERIA) assert.match(packet.prompt, new RegExp(c));
});

test('buildGradingPacket tells the grader when the diff was truncated', () => {
  const packet = buildGradingPacket({
    ledger: ledgerFixture(),
    diff: { files: [], diff: 'x', headSha: HEAD, baseSha: 'base', truncated: true },
  });
  assert.match(packet.prompt, /truncated/);
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

test('extractJson reads a fenced json block, a bare fence, and raw JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('prose {"a":3} more'), { a: 3 });
});

test('extractJson rejects empty or JSON-free replies', () => {
  assert.throws(() => extractJson(''), /empty/);
  assert.throws(() => extractJson('no object here'), /no JSON object/);
});

// ---------------------------------------------------------------------------
// parseGradeResponse
// ---------------------------------------------------------------------------

test('parseGradeResponse builds a valid passing stage', () => {
  const { stage, verdictOverridden } = parseGradeResponse(
    reply({ criteria: scores(4), verdict: 'pass', findings: [], notes: 'looks right' }),
    { graderModel: GRADER, headSha: HEAD },
  );
  assert.equal(stage.completed, true);
  assert.equal(stage.grader_model, GRADER);
  assert.equal(stage.head_sha, HEAD);
  assert.equal(stage.verdict, 'pass');
  assert.equal(stage.findings_count, 0);
  assert.equal(stage.notes, 'looks right');
  assert.equal(verdictOverridden, false);
  assert.equal(stage.escalated_to_human, undefined);
});

test('parseGradeResponse overrides a claimed pass when a criterion scores below 3', () => {
  const { stage, verdictOverridden } = parseGradeResponse(
    reply({ criteria: scores(4, { correctness: 2 }), verdict: 'pass', findings: [] }),
    { graderModel: GRADER, headSha: HEAD },
  );
  assert.equal(stage.verdict, 'fail');
  assert.equal(verdictOverridden, true);
  assert.match(stage.escalated_to_human.reason, /criteria below 3: correctness/);
  assert.equal(stage.escalated_to_human.unresolved_findings, 1);
});

test('parseGradeResponse overrides a claimed pass when a blocker finding is reported', () => {
  const { stage } = parseGradeResponse(
    reply({
      criteria: scores(5),
      verdict: 'pass',
      findings: [{ severity: 'blocker', file: 'src/a.ts', detail: 'nulls out state' }],
    }),
    { graderModel: GRADER, headSha: HEAD },
  );
  assert.equal(stage.verdict, 'fail');
  assert.match(stage.escalated_to_human.reason, /1 blocker finding/);
  assert.equal(stage.escalated_to_human.unresolved_findings, 1);
});

test('parseGradeResponse keeps a pass when only minor findings are reported', () => {
  const { stage } = parseGradeResponse(
    reply({
      criteria: scores(4),
      verdict: 'pass',
      findings: [{ severity: 'minor', file: 'src/a.ts', detail: 'naming' }],
    }),
    { graderModel: GRADER, headSha: HEAD },
  );
  assert.equal(stage.verdict, 'pass');
  assert.equal(stage.findings_count, 1);
});

test('parseGradeResponse treats a missing/unknown verdict as fail', () => {
  const { stage } = parseGradeResponse(reply({ criteria: scores(4), findings: [] }), {
    graderModel: GRADER,
    headSha: HEAD,
  });
  assert.equal(stage.verdict, 'fail');
  assert.match(stage.escalated_to_human.reason, /failing verdict/);
});

test('parseGradeResponse rejects a reply missing any criterion score', () => {
  const partial = scores(4);
  delete partial[GRADE_CRITERIA[0]];
  assert.throws(
    () =>
      parseGradeResponse(reply({ criteria: partial, verdict: 'pass' }), {
        graderModel: GRADER,
        headSha: HEAD,
      }),
    new RegExp(`missing valid 1\\.\\.5 scores for: ${GRADE_CRITERIA[0]}`),
  );
});

test('parseGradeResponse rejects out-of-range scores', () => {
  assert.throws(
    () =>
      parseGradeResponse(reply({ criteria: scores(9), verdict: 'pass' }), {
        graderModel: GRADER,
        headSha: HEAD,
      }),
    /missing valid 1\.\.5 scores/,
  );
});

test('parseGradeResponse requires a grader model and a graded sha', () => {
  const body = reply({ criteria: scores(4), verdict: 'pass' });
  assert.throws(() => parseGradeResponse(body, { graderModel: '', headSha: HEAD }), /graderModel/);
  assert.throws(() => parseGradeResponse(body, { graderModel: GRADER, headSha: '' }), /headSha/);
});

// ---------------------------------------------------------------------------
// applyGradeToLedger / formatGrade
// ---------------------------------------------------------------------------

test('applyGradeToLedger writes the stage without mutating the input ledger', () => {
  const led = ledgerFixture();
  const { stage } = parseGradeResponse(reply({ criteria: scores(4), verdict: 'pass' }), {
    graderModel: GRADER,
    headSha: HEAD,
  });
  const updated = applyGradeToLedger(led, stage);
  assert.equal(updated.stages.independent_grade.verdict, 'pass');
  assert.equal(led.stages.independent_grade, undefined, 'input must not be mutated');
  assert.equal(updated.stages.plan_review.reviewer_model, 'gpt-5.4', 'other stages preserved');
});

test('a graded ledger passes the ledger validator end to end', async () => {
  const { validateLedger } = await import('./ledger.mjs');
  const led = {
    schema_version: 'review-ledger/v2',
    date: '2026-08-02',
    session_slug: 'graded-change',
    task_title: 'Graded change',
    estimated_apples: 3,
    stages: {
      plan_review: {
        completed: true,
        reviewer_model: 'gpt-5.4',
        concerns_count: 0,
        resolved_count: 0,
        plan_divergence: 'convergent',
      },
      code_review: {
        clean: true,
        rounds: [
          {
            round: 1,
            models: ['claude-opus-4.8'],
            concerns_count: 0,
            resolved_count: 0,
            clean: true,
          },
        ],
      },
    },
  };
  const { stage } = parseGradeResponse(reply({ criteria: scores(4), verdict: 'pass' }), {
    graderModel: GRADER,
    headSha: HEAD,
  });
  const result = validateLedger(applyGradeToLedger(led, stage));
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('formatGrade summarizes the verdict, grader, sha, and scores', () => {
  const { stage } = parseGradeResponse(reply({ criteria: scores(4), verdict: 'pass' }), {
    graderModel: GRADER,
    headSha: HEAD,
  });
  const line = formatGrade(stage);
  assert.match(line, /independent_grade: pass/);
  assert.match(line, new RegExp(GRADER));
  assert.match(line, /correctness=4/);
});
