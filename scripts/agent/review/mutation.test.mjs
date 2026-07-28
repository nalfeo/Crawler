import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  UsageError,
  collectTestFiles,
  deriveTestFiles,
  evaluateReport,
  formatSummary,
  parseArgs,
  parseTarget,
} from './mutation.mjs';

const mutant = (status, line = 1, mutatorName = 'EqualityOperator') => ({
  status,
  mutatorName,
  location: { start: { line } },
});
const report = (mutants, file = 'src/a.ts') => ({ files: { [file]: { mutants } } });

// --- parseTarget -----------------------------------------------------------

test('parseTarget accepts a bare file with no range', () => {
  assert.deepEqual(parseTarget('src/a.ts'), {
    file: 'src/a.ts',
    startLine: null,
    endLine: null,
    spec: 'src/a.ts',
  });
});

test('parseTarget extracts an inclusive line range', () => {
  const parsed = parseTarget('src/core/map/astar-grid.ts:295-335');
  assert.equal(parsed.file, 'src/core/map/astar-grid.ts');
  assert.equal(parsed.startLine, 295);
  assert.equal(parsed.endLine, 335);
  assert.equal(parsed.spec, 'src/core/map/astar-grid.ts:295-335');
});

test('parseTarget does not mistake a Windows drive letter for a line range', () => {
  const parsed = parseTarget('C:\\repo\\src\\a.ts');
  assert.equal(parsed.file, 'C:\\repo\\src\\a.ts');
  assert.equal(parsed.startLine, null);
});

test('parseTarget keeps a drive letter while still parsing a real range', () => {
  const parsed = parseTarget('C:\\repo\\src\\a.ts:10-20');
  assert.equal(parsed.file, 'C:\\repo\\src\\a.ts');
  assert.equal(parsed.startLine, 10);
  assert.equal(parsed.endLine, 20);
});

test('parseTarget rejects an inverted range', () => {
  assert.throws(() => parseTarget('src/a.ts:40-10'), UsageError);
});

test('parseTarget rejects a zero start line', () => {
  assert.throws(() => parseTarget('src/a.ts:0-10'), UsageError);
});

test('parseTarget rejects an empty target', () => {
  assert.throws(() => parseTarget('   '), UsageError);
});

// --- parseArgs -------------------------------------------------------------

test('parseArgs defaults to zero tolerated survivors', () => {
  assert.equal(parseArgs(['src/a.ts']).maxSurvivors, 0);
});

test('parseArgs splits a comma-separated --tests list', () => {
  const options = parseArgs(['src/a.ts', '--tests', 'tests/a.test.ts, tests/b.test.ts']);
  assert.deepEqual(options.tests, ['tests/a.test.ts', 'tests/b.test.ts']);
});

test('parseArgs rejects a negative --max-survivors', () => {
  assert.throws(() => parseArgs(['src/a.ts', '--max-survivors', '-1']), UsageError);
});

test('parseArgs rejects an unknown option instead of ignoring it', () => {
  assert.throws(() => parseArgs(['src/a.ts', '--totally-made-up']), UsageError);
});

test('parseArgs rejects a flag whose value is missing', () => {
  assert.throws(() => parseArgs(['src/a.ts', '--tests', '--json']), UsageError);
});

test('parseArgs rejects more than one positional target', () => {
  assert.throws(() => parseArgs(['src/a.ts', 'src/b.ts']), UsageError);
});

test('parseArgs requires a target unless --help was passed', () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.equal(parseArgs(['--help']).help, true);
});

// --- deriveTestFiles -------------------------------------------------------

test('deriveTestFiles matches a test importing the target by basename', () => {
  const files = ['tests/a.test.ts', 'tests/b.test.ts'];
  const contents = {
    'tests/a.test.ts': "import { computeGridPath } from '../src/core/map/astar-grid';",
    'tests/b.test.ts': "import { other } from '../src/core/map/flow-field';",
  };
  const found = deriveTestFiles('src/core/map/astar-grid.ts', files, {
    readFileSync: (file) => contents[file],
  });
  assert.deepEqual(found, ['tests/a.test.ts']);
});

test('deriveTestFiles does not match a merely similar basename', () => {
  const contents = { 'tests/a.test.ts': "import x from '../src/core/map/astar-grid-helpers';" };
  const found = deriveTestFiles('src/core/map/astar-grid.ts', ['tests/a.test.ts'], {
    readFileSync: (file) => contents[file],
  });
  assert.deepEqual(found, []);
});

test('deriveTestFiles matches an import that keeps the file extension', () => {
  const contents = { 'tests/a.test.ts': "import x from '../src/core/map/astar-grid.ts';" };
  const found = deriveTestFiles('src/core/map/astar-grid.ts', ['tests/a.test.ts'], {
    readFileSync: (file) => contents[file],
  });
  assert.deepEqual(found, ['tests/a.test.ts']);
});

test('deriveTestFiles skips unreadable files rather than throwing', () => {
  const found = deriveTestFiles('src/a.ts', ['tests/a.test.ts'], {
    readFileSync: () => {
      throw new Error('EACCES');
    },
  });
  assert.deepEqual(found, []);
});

// --- collectTestFiles ------------------------------------------------------

test('collectTestFiles walks nested directories and skips node_modules', () => {
  const tree = {
    tests: ['nested', 'node_modules', 'a.test.ts', 'readme.md'],
    [`tests${sep()}nested`]: ['b.spec.ts'],
    [`tests${sep()}node_modules`]: ['c.test.ts'],
  };
  const dirs = new Set(Object.keys(tree));
  const found = collectTestFiles('tests', {
    readdirSync: (dir) => tree[dir] ?? [],
    lstatSync: (full) => ({ isDirectory: () => dirs.has(full) }),
  });
  assert.deepEqual(found, ['tests/a.test.ts', 'tests/nested/b.spec.ts']);
});

test('collectTestFiles does not traverse a symlinked directory', () => {
  // lstat reports the symlink itself, not its target, so `isDirectory()` is
  // false and the cycle is never entered.
  const tree = { tests: ['loop', 'a.test.ts'], [`tests${sep()}loop`]: ['b.test.ts'] };
  const found = collectTestFiles('tests', {
    readdirSync: (dir) => tree[dir] ?? [],
    lstatSync: () => ({ isDirectory: () => false }),
  });
  assert.deepEqual(found, ['tests/a.test.ts']);
});

function sep() {
  return path.sep;
}

// --- evaluateReport --------------------------------------------------------

test('evaluateReport passes when every mutant is killed', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('Killed', 2)]));
  assert.equal(result.ok, true);
  assert.equal(result.counts.killed, 2);
  assert.equal(result.score, 100);
});

test('evaluateReport counts a timeout as detected', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('Timeout', 2)]));
  assert.equal(result.ok, true);
  assert.equal(result.detected, 2);
  assert.equal(result.score, 100);
});

test('evaluateReport fails on a survivor and names it', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('Survived', 42)]));
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /SURVIVED/);
  assert.deepEqual(result.survivors, ['EqualityOperator at src/a.ts:42']);
});

test('evaluateReport honours a raised survivor tolerance', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('Survived', 42)]), {
    maxSurvivors: 1,
  });
  assert.equal(result.ok, true);
});

test('evaluateReport fails on a NoCoverage mutant even when nothing survived', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('NoCoverage', 7)]));
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /NO COVERAGE/);
});

test('evaluateReport still fails on NoCoverage when survivors are tolerated', () => {
  // The whole point: a generous --max-survivors must never launder an
  // un-exercised target into a pass.
  const result = evaluateReport(report([mutant('NoCoverage', 7)]), { maxSurvivors: 99 });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /NO COVERAGE/);
});

test('evaluateReport fails when a mutant produced no verdict', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('RuntimeError', 3)]));
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /no verdict/);
});

test('evaluateReport fails an empty report rather than scoring it 100%', () => {
  const result = evaluateReport(report([]));
  assert.equal(result.ok, false);
  assert.equal(result.total, 0);
  assert.equal(result.score, null);
  assert.match(result.failures.join('\n'), /No mutants were generated/);
});

test('evaluateReport fails a report of nothing but Ignored mutants', () => {
  // Regression: `total` counts Ignored mutants, so guarding on `total === 0`
  // let an all-ignored report print PASS having killed nothing.
  const result = evaluateReport(report([mutant('Ignored'), mutant('Ignored', 2)]));
  assert.equal(result.ok, false);
  assert.equal(result.valid, 0);
  assert.equal(result.score, null);
  assert.match(result.failures.join('\n'), /proved nothing/);
});

test('evaluateReport fails an all-Ignored report even when survivors are tolerated', () => {
  assert.equal(evaluateReport(report([mutant('Ignored')]), { maxSurvivors: 99 }).ok, false);
});

test('evaluateReport fails when every mutant errored and none produced a verdict', () => {
  const result = evaluateReport(report([mutant('CompileError'), mutant('RuntimeError', 2)]));
  assert.equal(result.ok, false);
  assert.equal(result.valid, 0);
  assert.match(result.failures.join('\n'), /proved nothing/);
});

test('evaluateReport fails a report whose mutants all have unrecognised statuses', () => {
  const result = evaluateReport(report([mutant('Bogus'), mutant('AlsoBogus', 2)]));
  assert.equal(result.ok, false);
  assert.equal(result.total, 0);
});

test('evaluateReport fails a completely absent files map', () => {
  assert.equal(evaluateReport({}).ok, false);
  assert.equal(evaluateReport(null).ok, false);
});

test('evaluateReport excludes ignored and errored mutants from the score', () => {
  const result = evaluateReport(
    report([
      mutant('Killed'),
      mutant('Ignored', 2),
      mutant('CompileError', 3),
      mutant('Survived', 4),
    ]),
  );
  assert.equal(result.valid, 2);
  assert.equal(result.score, 50);
});

test('evaluateReport aggregates mutants across multiple files', () => {
  const result = evaluateReport({
    files: {
      'src/a.ts': { mutants: [mutant('Killed')] },
      'src/b.ts': { mutants: [mutant('Survived', 9)] },
    },
  });
  assert.equal(result.total, 2);
  assert.deepEqual(result.survivors, ['EqualityOperator at src/b.ts:9']);
});

test('evaluateReport fails a mixed Killed+Ignored report even though valid > 0', () => {
  // Regression: a mixed report has valid > 0 so the valid===0 guard does not fire,
  // but the ignored mutant was never applied -- it should be flagged.
  const result = evaluateReport(report([mutant('Killed'), mutant('Ignored', 2)]));
  assert.equal(result.ok, false);
  assert.equal(result.counts.ignored, 1);
  assert.match(result.failures.join('\n'), /IGNORED/);
});

// --- formatSummary ---------------------------------------------------------

test('formatSummary reports a pass', () => {
  const summary = formatSummary(evaluateReport(report([mutant('Killed')])), {
    target: 'src/a.ts:1-2',
  });
  assert.match(summary, /PASS/);
  assert.match(summary, /src\/a\.ts:1-2/);
});

test('formatSummary with nonzero maxSurvivors says tolerance instead of all-detected', () => {
  const result = evaluateReport(report([mutant('Killed'), mutant('Survived', 2)]), {
    maxSurvivors: 1,
  });
  const summary = formatSummary(result, { target: 'src/a.ts', maxSurvivors: 1 });
  assert.match(summary, /PASS/);
  assert.match(summary, /tolerance/);
  assert.doesNotMatch(summary, /every mutant in scope was detected/);
});

test('formatSummary with zero maxSurvivors says all-detected when passing', () => {
  const result = evaluateReport(report([mutant('Killed')]));
  const summary = formatSummary(result, { target: 'src/a.ts', maxSurvivors: 0 });
  assert.match(summary, /PASS/);
  assert.match(summary, /every mutant in scope was detected/);
});

test('formatSummary lists every survivor when there is more than one', () => {
  const result = evaluateReport(report([mutant('Survived', 1), mutant('Survived', 2)]));
  const summary = formatSummary(result, { target: 'src/a.ts', tests: ['tests/a.test.ts'] });
  assert.match(summary, /FAIL/);
  assert.match(summary, /src\/a\.ts:1/);
  assert.match(summary, /src\/a\.ts:2/);
});

test('formatSummary flags auto-derived test selection', () => {
  const summary = formatSummary(evaluateReport(report([mutant('Killed')])), {
    target: 'src/a.ts',
    tests: ['tests/a.test.ts'],
    derived: true,
  });
  assert.match(summary, /auto-derived/);
});
