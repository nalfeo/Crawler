import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadBrief } from '../../../scripts/sprites/load-brief.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('batfolk-sonic-shooter brief', () => {
  it('loads as a Floor 2 enemy brief with explicit sonic-weapon cues', () => {
    const briefPath = path.join(REPO_ROOT, 'briefs', 'enemies', 'batfolk-sonic-shooter.yaml');
    const { brief } = loadBrief(briefPath, { projectRoot: REPO_ROOT });

    expect(brief.type).toBe('enemy');
    expect(brief.name).toBe('batfolk-sonic-shooter');
    expect(brief.mobRole).toBe('normal');
    expect(brief.floor).toBe(2);
    expect(brief.variations).toHaveLength(4);
    expect(brief.sensors.enemy?.facing).toBe('three-quarter');
    expect(brief.judge?.enabled).toBe(true);
    expect(brief.judge?.maxVariants).toBe(4);
    expect(brief.prompt).toContain('wide-mouthed speaker-gun');
    expect(brief.prompt).toContain('sound-wave rings');
    expect(brief.prompt).toContain('wraparound visor');
    expect(brief.prompt).toContain('dark purple');
  });
});
