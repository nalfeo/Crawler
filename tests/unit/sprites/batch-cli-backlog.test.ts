import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../../scripts/sprites/batch-cli.js';

describe('sprites:batch backlog arguments', () => {
  it('parses floor and limit settings', () => {
    const args = parseArgs([
      '--backlog-floors',
      '1,2,3',
      '--limit',
      '5',
      '--retry',
      'npc-guide',
      '--dry-run',
    ]);

    expect(args.backlogFloors).toEqual([1, 2, 3]);
    expect(args.limit).toBe(5);
    expect(args.retryConcepts).toEqual(['npc-guide']);
    expect(args.dryRun).toBe(true);
  });

  it('rejects invalid floors and limits', () => {
    expect(() => parseArgs(['--backlog-floors', '1,nope'])).toThrow('positive integers');
    expect(() => parseArgs(['--limit', '0'])).toThrow('positive integer');
    expect(() => parseArgs(['--retry', 'npc-guide'])).toThrow('requires --backlog-floors');
    expect(() =>
      parseArgs(['--backlog-floors', '1,2,3', '--brief', 'briefs/items/pebble.yaml']),
    ).toThrow('cannot be combined');
  });
});
