/**
 * Tests for lib/brief-lookup.mjs's `resolveBriefEntry` — the fix for the
 * review finding that "View Brief" could open the WRONG file when a draft
 * and a committed brief share the same basename/id. `findBriefEntry` (the
 * pre-fix renderer.mjs helper) matched by basename ONLY, returning whichever
 * entry happened to appear first in `state.files.briefs` — `resolveBriefEntry`
 * instead prefers an EXACT `relPath` match against the run's own
 * `selected.briefPath` (plumbed through from the run's summary.json by
 * extension.mjs's `liveBuildState`), falling back to the ambiguous basename
 * match only when no exact path is available.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findBriefEntryByPath,
  findBriefEntryByBasename,
  resolveBriefEntry,
} from '../lib/brief-lookup.mjs';

const DUPLICATE_BASENAME_BRIEFS = [
  { relPath: 'briefs/draft/goblin.yaml', name: 'goblin' },
  { relPath: 'briefs/goblin.yaml', name: 'goblin' },
];

test('findBriefEntryByPath: exact relPath match', () => {
  const entry = findBriefEntryByPath(DUPLICATE_BASENAME_BRIEFS, 'briefs/goblin.yaml');
  assert.equal(entry.relPath, 'briefs/goblin.yaml');
});

test('findBriefEntryByPath: no match returns null', () => {
  assert.equal(findBriefEntryByPath(DUPLICATE_BASENAME_BRIEFS, 'briefs/missing.yaml'), null);
});

test('findBriefEntryByBasename: returns the FIRST entry with a matching basename (ambiguous with duplicates)', () => {
  const entry = findBriefEntryByBasename(DUPLICATE_BASENAME_BRIEFS, 'goblin');
  // This is the pre-fix, ambiguous behavior — kept available as the
  // documented fallback for runs with no exact briefPath.
  assert.equal(entry.relPath, 'briefs/draft/goblin.yaml');
});

test('resolveBriefEntry: a duplicate basename is resolved via the exact briefPath, not basename order', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  const sel = { briefId: 'goblin', briefPath: 'briefs/goblin.yaml' };
  const entry = resolveBriefEntry(state, sel);
  assert.equal(
    entry.relPath,
    'briefs/goblin.yaml',
    "the run's EXACT committed brief must win, not the draft basename match",
  );
});

test('resolveBriefEntry: the OTHER duplicate is resolved correctly too, proving it is not order-dependent', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  const sel = { briefId: 'goblin', briefPath: 'briefs/draft/goblin.yaml' };
  const entry = resolveBriefEntry(state, sel);
  assert.equal(entry.relPath, 'briefs/draft/goblin.yaml');
});

test('resolveBriefEntry: falls back to basename match when briefPath is absent (older run summary)', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  const sel = { briefId: 'goblin', briefPath: null };
  const entry = resolveBriefEntry(state, sel);
  assert.equal(entry.relPath, 'briefs/draft/goblin.yaml');
});

test('resolveBriefEntry: falls back to basename match when briefPath does not match any allowlisted entry', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  const sel = { briefId: 'goblin', briefPath: 'briefs/some-other-location/goblin.yaml' };
  const entry = resolveBriefEntry(state, sel);
  assert.equal(entry.relPath, 'briefs/draft/goblin.yaml');
});

test('resolveBriefEntry: never returns a path outside the provided (already-allowlisted) briefs listing', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  const sel = { briefId: 'goblin', briefPath: '../../etc/passwd' };
  const entry = resolveBriefEntry(state, sel);
  // No exact match for a path outside the listing, so this degrades to the
  // basename fallback — it can NEVER return an entry whose relPath isn't one
  // of the ones already in `state.files.briefs`.
  assert.equal(entry.relPath, 'briefs/draft/goblin.yaml');
});

test('resolveBriefEntry: no selection returns null', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  assert.equal(resolveBriefEntry(state, null), null);
});

test('resolveBriefEntry: no matching brief at all returns null', () => {
  const state = { files: { briefs: DUPLICATE_BASENAME_BRIEFS } };
  const sel = { briefId: 'ogre', briefPath: null };
  assert.equal(resolveBriefEntry(state, sel), null);
});

test('resolveBriefEntry: tolerates a missing files/briefs listing', () => {
  assert.equal(resolveBriefEntry({}, { briefId: 'goblin', briefPath: null }), null);
});
