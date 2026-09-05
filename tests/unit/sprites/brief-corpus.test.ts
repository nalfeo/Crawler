import { describe, expect, it } from 'vitest';

import { collectBacklogBriefs } from '../../../scripts/sprites/sprite-backlog.js';

describe('committed sprite brief corpus', () => {
  it('contains no invalid non-draft briefs', () => {
    const discovered = collectBacklogBriefs(process.cwd());

    expect(discovered.invalidBriefs).toEqual([]);
  });
});
