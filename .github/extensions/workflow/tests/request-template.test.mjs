import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRequestTemplate, renderRequestTemplate } from '../lib/request-template.mjs';

const BASE = {
  name: '',
  brief: '',
  type: 'auto',
  size: 'default',
  floorNumber: '',
  floorContext: '',
  familyContext: '',
  role: '',
  priority: 'normal',
  requester: '',
  crawlerDesignLanguage: 'canonical crawler language',
  categoryInjection: '',
  floorInjection: '',
  familyInjection: '',
};

test('render and parse preserve empty optional authoring fields', () => {
  const parsed = parseRequestTemplate(renderRequestTemplate(BASE));
  assert.equal(parsed.name, '[not entered]');
  assert.equal(parsed.brief, '[none]');
  assert.equal(parsed.floorNumber, '[none]');
  assert.equal(parsed.categoryInjection, '[resolved after automatic type classification]');
  assert.equal(parsed.floorInjection, '[none]');
  assert.equal(parsed.familyInjection, '[none]');
});

test('render and parse preserve populated request fields', () => {
  const parsed = parseRequestTemplate(
    renderRequestTemplate({
      ...BASE,
      name: 'main-player',
      brief: 'Facing south.',
      type: 'character',
      size: 'tall',
      floorNumber: '7',
      floorContext: 'floor2 · Floor 2',
      familyContext: 'goblins',
      role: 'elite',
      priority: 'high',
      requester: 'artist',
      categoryInjection: 'character language',
      floorInjection: 'floor language',
      familyInjection: 'family language',
    }),
  );
  assert.deepEqual(parsed, {
    name: 'main-player',
    brief: 'Facing south.',
    type: 'character',
    size: 'tall',
    floorNumber: '7',
    floorContext: 'floor2 · Floor 2',
    familyContext: 'goblins',
    role: 'elite',
    priority: 'high',
    requester: 'artist',
    categoryInjection: 'character language',
    floorInjection: 'floor language',
    familyInjection: 'family language',
  });
});

test('heading-like prose inside the brief does not terminate unless line-anchored', () => {
  const parsed = parseRequestTemplate(
    renderRequestTemplate({
      ...BASE,
      brief: 'Discuss Sprite type: only as prose, not as a field heading.',
    }),
  );
  assert.equal(parsed.brief, 'Discuss Sprite type: only as prose, not as a field heading.');
});
