import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_AXES,
  mediaTypeFor,
  normalizeReview,
  parseArgs,
  parseMetadataText,
} from './arbitrary-screenshot-lib.mjs';

function response() {
  return {
    observable: Object.fromEntries(
      REVIEW_AXES.map((axis) => [
        axis,
        {
          score: 80,
          observation: `${axis} is visible`,
          evidence: `Visible ${axis} label`,
        },
      ]),
    ),
    not_observable: ['Interaction behavior is not proven.'],
    evidence: [{ criterion: 'legibility', observation: 'Labels are visible', confidence: 0.9 }],
    player_cost: ['Comparison takes an extra glance.'],
    hard_failures: [],
  };
}

test('resolves supported image media types', () => {
  assert.equal(mediaTypeFor('screen.PNG'), 'image/png');
  assert.equal(mediaTypeFor('screen.jpeg'), 'image/jpeg');
  assert.equal(mediaTypeFor('screen.webp'), 'image/webp');
  assert.throws(() => mediaTypeFor('screen.gif'), /PNG, JPEG, or WebP/);
});

test('parses CLI args and rejects unknown or incomplete flags', () => {
  assert.deepEqual(parseArgs(['--image=screen.png', '--min-score', '75']), {
    image: 'screen.png',
    metadata: undefined,
    output: undefined,
    minScore: 75,
    minCoverage: null,
  });
  assert.throws(() => parseArgs(['--image', 'screen.png', '--unknown', 'x']), /unknown argument/);
  assert.throws(() => parseArgs(['--image']), /requires a value/);
});

test('validates metadata shape', () => {
  assert.deepEqual(parseMetadataText('{"task":"compare gear","viewport":"1280x720"}'), {
    task: 'compare gear',
    viewport: '1280x720',
  });
  assert.throws(() => parseMetadataText('[]'), /JSON object/);
});

test('computes local coverage and score from the rubric', () => {
  const result = normalizeReview(response(), {
    image: 'screen.png',
    metadata: {},
    modelDeployment: 'test',
  });
  assert.equal(result.coverage, 100);
  assert.equal(result.score, 80);
  assert.deepEqual(result.hardFailures, []);
});

test('fails closed for absent rubric or behavior claims', () => {
  assert.throws(
    () => normalizeReview({}, { image: 'screen.png', metadata: {}, modelDeployment: 'test' }),
    /missing observable/,
  );
  const raw = response();
  raw.observable.legibility.observation = 'Hovering reveals the item value';
  assert.throws(
    () => normalizeReview(raw, { image: 'screen.png', metadata: {}, modelDeployment: 'test' }),
    /behavior claim/,
  );
});
