import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/sprites/theme-equipment-cli.js';

describe('theme-equipment-cli parseArgs', () => {
  it('parses each action with its required selector', () => {
    expect(parseArgs(['init', '--plan', 'data/theme-equipment-sets/classic-fantasy.json'])).toEqual(
      {
        action: 'init',
        planPath: 'data/theme-equipment-sets/classic-fantasy.json',
      },
    );
    expect(parseArgs(['run-phase', '--set-id', 'classic-fantasy'])).toEqual({
      action: 'run-phase',
      setId: 'classic-fantasy',
    });
    expect(parseArgs(['publish', '--set-id', 'classic-fantasy']).action).toBe('publish');
  });

  it('rejects missing and incompatible action arguments', () => {
    expect(() => parseArgs(['init'])).toThrow(/requires --plan/);
    expect(() => parseArgs(['status'])).toThrow(/requires --set-id/);
    expect(() => parseArgs(['init', '--plan', 'x.json', '--set-id', 'x'])).toThrow(/omit --set-id/);
  });
});
