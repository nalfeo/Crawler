import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../extension.mjs', import.meta.url), 'utf8');

/**
 * Execute the real scale-inference block from reviewResults() so this test
 * proves backend behavior rather than matching source text.
 */
function inferScale(review) {
  const start = SRC.indexOf('        const isWrappedReview =');
  const end = SRC.indexOf('        const imagePath =');
  assert.ok(start > -1 && end > start, 'scale-inference block must be locatable');
  const body = `let out = { isWrappedReview: false, isRawAzureReview: false, rawScale: null };
for (let _i = 0; _i < 1; _i++) {
${SRC.slice(start, end)}
out = { isWrappedReview, isRawAzureReview, rawScale };
}
return out;`;
  return new Function('review', body)(review);
}

test('a current 0-100 raw review is accepted and reported on the 100 scale', () => {
  const r = inferScale({
    overall: { score: 72 },
    axes: { layout_consistency: { score: 68 }, spacing_balance: { score: 65 } },
  });
  assert.equal(r.isRawAzureReview, true);
  assert.equal(r.rawScale, 100);
});

test('a legacy 1-5 raw review still renders on the 5 scale', () => {
  const r = inferScale({
    overall: { score: 3 },
    axes: { layout_consistency: { score: 3 }, spacing_balance: { score: 2 } },
  });
  assert.equal(r.isRawAzureReview, true);
  assert.equal(r.rawScale, 5);
});

test('a genuinely terrible 0-100 review with a high axis is not mistaken for legacy', () => {
  const r = inferScale({
    overall: { score: 4 },
    axes: { layout_consistency: { score: 4 }, spacing_balance: { score: 40 } },
  });
  assert.equal(r.rawScale, 100);
});

test('a wrapped review is unaffected by raw-scale inference', () => {
  const r = inferScale({ schemaVersion: 1, image: '/tmp/a.png', score: 81 });
  assert.equal(r.isWrappedReview, true);
});

test('a review with no usable score is rejected', () => {
  const r = inferScale({ overall: {}, axes: {} });
  assert.equal(r.isWrappedReview, false);
  assert.equal(r.isRawAzureReview, false);
});
