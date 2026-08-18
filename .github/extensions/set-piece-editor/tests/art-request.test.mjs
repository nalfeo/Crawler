import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ASSET_REQUEST_MARKER,
  BRIEF_MAX_NORMALIZED_LENGTH,
  BRIEF_MAX_RAW_LENGTH,
  BRIEF_MIN_LENGTH,
  SIZE_VARIANTS,
  SPRITE_TYPES,
  bareConceptOf,
  buildArtRequestIssue,
  suggestVariantName,
} from '../lib/art-request.mjs';

const GOOD = { name: 'bearskin-rug', brief: 'A shaggy bearskin rug splayed on flagstones.' };

/** Re-parse our own marker the way `parseAssetRequestIssueBody` does. */
function readMarker(body) {
  const start = body.indexOf(`<!-- ${ASSET_REQUEST_MARKER}`);
  assert.ok(start >= 0, 'marker missing');
  const end = body.indexOf('-->', start);
  return JSON.parse(body.slice(start + `<!-- ${ASSET_REQUEST_MARKER}`.length, end).trim());
}

test('builds a new-art request with a machine marker the pipeline can parse', () => {
  const r = buildArtRequestIssue(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Asset request: bearskin-rug');
  assert.deepEqual(r.labels, ['asset-request']);
  assert.deepEqual(readMarker(r.body), {
    version: 1,
    name: 'bearskin-rug',
    briefSentence: 'A shaggy bearskin rug splayed on flagstones.',
  });
  // Human-readable headings are emitted too, so the request still parses via
  // the issue-form fallback if the marker is ever stripped.
  assert.match(r.body, /^### Name$/m);
  assert.match(r.body, /^### Brief$/m);
});

test('optional fields are omitted from the marker when blank, not sent empty', () => {
  const r = buildArtRequestIssue({ ...GOOD, type: '', floor: '', sizeVariant: '' });
  const marker = readMarker(r.body);
  assert.equal('type' in marker, false);
  assert.equal('floor' in marker, false);
  assert.equal('sizeVariant' in marker, false);
});

test('optional fields round-trip when supplied', () => {
  const r = buildArtRequestIssue({ ...GOOD, type: 'prop', floor: '3', sizeVariant: 'wide' });
  assert.deepEqual(readMarker(r.body), {
    version: 1,
    name: 'bearskin-rug',
    briefSentence: GOOD.brief,
    type: 'prop',
    floor: 3,
    sizeVariant: 'wide',
  });
});

test('a variant request writes the reference into the BRIEF, not a side field', () => {
  // The generator consumes `briefSentence` verbatim as its brief hint. A
  // reference stored anywhere else would produce a request that looks filed
  // and silently ignores the thing it was supposed to be based on.
  const r = buildArtRequestIssue({
    name: 'welcome-room-stove-east',
    brief: 'Same stove, but facing east instead of south.',
    basedOn: 'welcome-room-stove-v2-var-3',
  });
  assert.equal(r.ok, true);
  const marker = readMarker(r.body);
  assert.match(marker.briefSentence, /welcome-room-stove-v2-var-3/);
  assert.match(marker.briefSentence, /facing east instead of south/);
  assert.match(marker.briefSentence, /palette, outline weight, scale/);
  assert.equal('basedOn' in marker, false, 'basedOn is prose, not a marker field');
});

test('rejects bad names, briefs, types, sizes and floors with all issues at once', () => {
  const r = buildArtRequestIssue({
    name: 'Bearskin Rug',
    brief: 'tiny',
    type: 'furniture',
    sizeVariant: 'huge',
    floor: '99',
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 5, `expected 5 issues, got ${JSON.stringify(r.errors)}`);
  assert.ok(r.errors.some((e) => /kebab-case/.test(e)));
  assert.ok(r.errors.some((e) => /too short/.test(e)));
  assert.ok(r.errors.some((e) => /Type must be/.test(e)));
  assert.ok(r.errors.some((e) => /Size must be/.test(e)));
  assert.ok(r.errors.some((e) => /1 through 20/.test(e)));
});

test('requires a name and a brief', () => {
  assert.deepEqual(buildArtRequestIssue({ brief: GOOD.brief }).errors, ['Name is required.']);
  assert.ok(buildArtRequestIssue({ name: 'x-y' }).errors.some((e) => /too short/.test(e)));
});

test('brief whitespace is collapsed so the marker payload is stable', () => {
  const r = buildArtRequestIssue({ ...GOOD, brief: '  A   rug\n\non\tstones.  ' });
  assert.equal(readMarker(r.body).briefSentence, 'A rug on stones.');
});

test('rejects an over-long brief on both the raw and collapsed axes', () => {
  const raw = buildArtRequestIssue({ ...GOOD, brief: 'a '.repeat(BRIEF_MAX_RAW_LENGTH) });
  assert.equal(raw.ok, false);
  assert.ok(raw.errors.some((e) => new RegExp(String(BRIEF_MAX_RAW_LENGTH)).test(e)));

  const collapsed = buildArtRequestIssue({ ...GOOD, brief: 'x'.repeat(BRIEF_MAX_RAW_LENGTH - 1) });
  assert.equal(collapsed.ok, false);
  assert.ok(collapsed.errors.some((e) => /collapsed/.test(e)));
});

test('bareConceptOf strips version and variant suffixes', () => {
  assert.equal(bareConceptOf('generated:welcome-room-stove-v2-var-3'), 'welcome-room-stove');
  assert.equal(bareConceptOf('bearskin-rug'), 'bearskin-rug');
  assert.equal(bareConceptOf('rhea-vale-var-0'), 'rhea-vale');
});

test('suggestVariantName is a suggestion, bounded to three words', () => {
  assert.equal(
    suggestVariantName('welcome-room-stove-v2-var-3', 'east facing instead of south'),
    'welcome-room-stove-east-facing-instead',
  );
  assert.equal(suggestVariantName('stove-v1-var-0', ''), 'stove');
});

// --- contract drift guard ---------------------------------------------------
// This extension is standalone .mjs and cannot import the TS pipeline, so the
// bounds and enums above are hand-copied. The editor's other hand-copied
// contracts (the field allow-lists) have drifted twice, both times shipping a
// total save blocker — so the copies are asserted against their source here.
test('request bounds and enums match the asset-request pipeline', () => {
  const url = (p) => new URL(`../../../../${p}`, import.meta.url);
  const assetRequestTs = readFileSync(url('scripts/sprites/asset-request.ts'), 'utf8');
  const spriteTypesTs = readFileSync(url('src/shared/sprite-types.ts'), 'utf8');
  const sizeVariantsTs = readFileSync(url('scripts/sprites/size-variants.ts'), 'utf8');

  const num = (name) => {
    const m = assetRequestTs.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    assert.ok(m, `could not read ${name} from asset-request.ts`);
    return Number(m[1]);
  };
  assert.equal(BRIEF_MIN_LENGTH, num('BRIEF_MIN_LENGTH'));
  assert.equal(BRIEF_MAX_NORMALIZED_LENGTH, num('BRIEF_MAX_NORMALIZED_LENGTH'));
  assert.equal(BRIEF_MAX_RAW_LENGTH, num('BRIEF_MAX_RAW_LENGTH'));

  const list = (src, name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    assert.ok(m, `could not read ${name}`);
    const parsed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(parsed.length > 0, `parsed no entries for ${name}`);
    return parsed;
  };
  assert.deepEqual(SPRITE_TYPES, list(spriteTypesTs, 'SPRITE_TYPES'));
  assert.deepEqual(SIZE_VARIANTS, list(sizeVariantsTs, 'SIZE_VARIANTS'));

  const markerTs = assetRequestTs.match(/ASSET_REQUEST_MARKER\s*=\s*'([^']+)'/);
  assert.ok(markerTs, 'could not read ASSET_REQUEST_MARKER');
  assert.equal(ASSET_REQUEST_MARKER, markerTs[1]);
});
