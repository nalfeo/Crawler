import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hallway smoothing lab wiring', () => {
  it('registers the hallway smoothing lab and exposes the side-by-side debug scene', () => {
    const source = readFileSync('src/labs/hallway-smoothing-lab/index.ts', 'utf-8');
    expect(source).toContain("const LAB_ID = 'hallway-smoothing-lab';");
    expect(source).toContain("metricsEl.dataset.testid = 'hallway-smoothing-metrics';");
    expect(source).toContain("name: 'Hallway Smoothing'");
    expect(source).toContain('measurePassageJaggedness(floorMap);');
    expect(source).toContain('window.__hallwaySmoothingDebug = {');
    expect(source).toContain('buildTerrainLayer(this, floorMap, { smoothPassages: false });');
    expect(source).toContain('buildTerrainLayer(this, floorMap, { smoothPassages: true });');
  });

  it('adds the hallway smoothing lab to the lab loader', () => {
    const source = readFileSync('src/lab-main.ts', 'utf-8');
    expect(source).toContain("'hallway-smoothing-lab': '/src/labs/hallway-smoothing-lab/index.ts'");
  });
});
