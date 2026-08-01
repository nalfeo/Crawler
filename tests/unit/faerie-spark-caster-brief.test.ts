import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadBrief } from '../../scripts/sprites/load-brief.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRIEF_PATH = path.join(PROJECT_ROOT, 'briefs', 'enemies', 'faerie-spark-caster.yaml');

describe('faerie-spark-caster brief', () => {
  it('loads as a Floor 2 enemy brief with explicit electric-casting direction', () => {
    const { brief } = loadBrief(BRIEF_PATH, { projectRoot: PROJECT_ROOT });

    expect(brief.name).toBe('faerie-spark-caster');
    expect(brief.type).toBe('enemy');
    expect(brief.mobRole).toBe('normal');
    expect(brief.floor).toBe(2);
    expect(brief.size).toEqual({ width: 256, height: 256 });
    expect(brief.sensors.enemy?.facing).toBe('front');
    expect(brief.judge?.enabled).toBe(true);
    expect(brief.judge?.maxVariants).toBe(4);
    expect(brief.variations).toHaveLength(4);
    expect(brief.prompt).toContain('bright yellow-white electrical');
    expect(brief.prompt).toContain('both arms raised and palms forward');
  });
});
