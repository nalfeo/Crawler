import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBrief } from '../../../scripts/sprites/load-brief.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('gnome-wheelman brief', () => {
  it('loads as a committed Floor 2 enemy brief with the expected motion cues', () => {
    const briefPath = path.join(REPO_ROOT, 'briefs', 'enemies', 'gnome-wheelman.yaml');
    const { brief } = loadBrief(briefPath, { projectRoot: REPO_ROOT });

    expect(brief.type).toBe('enemy');
    expect(brief.name).toBe('gnome-wheelman');
    expect(brief.floor).toBe(2);
    expect(brief.minVariations).toBe(6);
    expect(brief.prompt).toContain('one-wheeled contraption');
    expect(brief.prompt).toContain('oversized wrench');
    expect(brief.sensors.enemy?.facing).toBe('three-quarter');
    expect(brief.judge?.enabled).toBe(true);
  });
});
