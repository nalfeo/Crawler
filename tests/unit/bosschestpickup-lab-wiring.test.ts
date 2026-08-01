import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('bosschestpickup lab wiring', () => {
  it('is registered in LAB_MODULE_PATHS in lab-main.ts', () => {
    const labMain = readFileSync('src/lab-main.ts', 'utf-8');
    expect(labMain).toContain("'bosschestpickup-lab': '/src/labs/bosschestpickup-lab/index.ts'");
  });

  it('registers under the loader key and seeds a real boss chest reward bundle', () => {
    const source = readFileSync('src/labs/bosschestpickup-lab/index.ts', 'utf-8');
    expect(source).toContain("registerLab('bosschestpickup-lab',");
    expect(source).toContain('spawnBossChestForDefeatedBoss(world, FAMILY_ID, CHEST_X, CHEST_Y)');
  });
});
