import test from 'node:test';
import assert from 'node:assert/strict';
import guard, { isManualAppleWriteSegment } from '../guards/shell-apple-metrics-write-only.mjs';

const run = (cmd) => guard.check({ command: cmd });

test('denies shell redirection writes into apples directory', () => {
  assert.equal(
    run('cat <<EOF > docs/knowledge/metrics/apples/2026-06-24-session.json\n{}\nEOF').decision,
    'deny',
  );
});

test('denies cp writes into apples directory', () => {
  assert.equal(
    run('cp /tmp/x.json docs/knowledge/metrics/apples/2026-06-24-session.json').decision,
    'deny',
  );
});

test('allows canonical npm writer command', () => {
  assert.equal(
    run('npm run docs:apple:write -- --date 2026-06-24 --session test --estimated 2 --actual 3')
      .decision,
    'allow',
  );
});

test('allows read-only shell usage on apple metrics', () => {
  assert.equal(run('cat docs/knowledge/metrics/apples/2026-06-24-session.json').decision, 'allow');
});

test('detects manual write segments', () => {
  assert.equal(
    isManualAppleWriteSegment('echo "{}" > docs/knowledge/metrics/apples/2026-06-24-session.json'),
    true,
  );
  assert.equal(
    isManualAppleWriteSegment(
      'npm run docs:apple:write -- --date 2026-06-24 --session test --estimated 2 --actual 2',
    ),
    false,
  );
});
