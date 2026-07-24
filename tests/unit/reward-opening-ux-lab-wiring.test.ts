import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('reward-opening-ux lab wiring', () => {
  it('is registered in LAB_MODULE_PATHS in lab-main.ts', () => {
    const labMain = readFileSync('src/lab-main.ts', 'utf-8');
    expect(labMain).toContain(
      "'reward-opening-ux-lab': '/src/labs/reward-opening-ux-lab/index.ts'",
    );
  });

  it('declares the correct LAB_ID in index.ts', () => {
    const source = readFileSync('src/labs/reward-opening-ux-lab/index.ts', 'utf-8');
    expect(source).toContain("const LAB_ID = 'reward-opening-ux-lab';");
  });
});
