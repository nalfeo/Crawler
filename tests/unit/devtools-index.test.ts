import { describe, expect, it } from 'vitest';
import { DEVTOOLS_INDEX_ENTRIES } from '../../src/devtools/index.js';

describe('devtools home index', () => {
  it('surfaces the backlog/workflow tool alongside review tools', () => {
    expect(DEVTOOLS_INDEX_ENTRIES.map((entry) => entry.id)).toEqual([
      'sprite-generation-workflow',
      'sprite-review',
      'postprocess',
    ]);
  });

  it('keeps index ids unique', () => {
    const ids = DEVTOOLS_INDEX_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
