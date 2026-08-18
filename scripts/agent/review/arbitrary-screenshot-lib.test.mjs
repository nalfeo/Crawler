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

test('caps severe overflow and wasted-space findings', () => {
  const raw = response();
  raw.hard_failures = ['text overflows off-screen'];
  raw.player_cost = ['copious wasted space'];
  const result = normalizeReview(raw, {
    image: 'screen.png',
    metadata: {},
    modelDeployment: 'test',
  });
  assert.equal(result.observable.text_safety.score, 10);
  assert.equal(result.observable.workspace_use.score, 40);
  assert.ok(result.score <= 45);
});

test('caps workspace use for region-specific empty-space findings', () => {
  const raw = response();
  raw.player_cost = ['The paper-doll region has substantial empty background and padding.'];
  const result = normalizeReview(raw, {
    image: 'screen.png',
    metadata: {},
    modelDeployment: 'test',
  });
  assert.equal(result.observable.workspace_use.score, 40);
});

test('caps workspace use for a full-frame dead band', () => {
  const raw = response();
  raw.player_cost = ['A large empty band runs along the bottom edge of the frame.'];
  const result = normalizeReview(raw, {
    image: 'screen.png',
    metadata: {},
    modelDeployment: 'test',
  });
  assert.equal(result.observable.workspace_use.score, 40);
});

test('caps task readiness for unlabeled paper-doll slots', () => {
  const raw = response();
  raw.player_cost = ['Unlabeled equipment slots make each position hard to name.'];
  const result = normalizeReview(raw, {
    image: 'screen.png',
    metadata: {},
    modelDeployment: 'test',
  });
  assert.equal(result.observable.task_readiness.score, 55);
});

test('caps legibility for small text and wide label-value gaps', () => {
  const small = response();
  small.player_cost = ['Small font size in the stats column raises reading cost.'];
  assert.equal(
    normalizeReview(small, { image: 'screen.png', metadata: {}, modelDeployment: 'test' })
      .observable.legibility.score,
    55,
  );

  const gap = response();
  gap.player_cost = ['A wide gap separates each label from its value in the stats column.'];
  assert.equal(
    normalizeReview(gap, { image: 'screen.png', metadata: {}, modelDeployment: 'test' }).observable
      .legibility.score,
    55,
  );
});

test('leaves axes uncapped when no matching finding is reported', () => {
  const raw = response();
  raw.player_cost = ['Comparison takes an extra glance.'];
  const result = normalizeReview(raw, {
    image: 'screen.png',
    metadata: {},
    modelDeployment: 'test',
  });
  assert.equal(result.observable.workspace_use.score, 80);
  assert.equal(result.observable.task_readiness.score, 80);
  assert.equal(result.observable.legibility.score, 80);
});

test('suppresses unsupported fuzziness findings when text-raster evidence passes', () => {
  const raw = response();
  raw.player_cost = [
    'Text is blurry in the bag column.',
    'A wide gap separates a stat label and value.',
  ];
  const result = normalizeReview(raw, {
    image: 'screen.png',
    metadata: { textRaster: { passed: true } },
    modelDeployment: 'test',
  });
  assert.equal(result.suppressedTextRasterFindings, 1);
  assert.deepEqual(result.playerCost, ['A wide gap separates a stat label and value.']);
  assert.equal(result.observable.legibility.score, 55);
});
