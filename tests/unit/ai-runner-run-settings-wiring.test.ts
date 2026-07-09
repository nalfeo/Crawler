import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner run-settings wiring', () => {
  it('uses one staged apply flow for seed/floor/scenario', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');

    expect(source).toContain('id="ai-run-apply"');
    expect(source).toContain('id="ai-run-target-select"');
    expect(source).toContain('decodeRunTarget');
    expect(source).toContain("runTarget.kind === 'scenario' ? 'floor1' : runTarget.floorId");
    expect(source).toContain('resolveScenarioPresetForFloor');
    expect(source).toContain("if (floorId === 'floor1')");
    expect(source).toContain('DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID');
    expect(source).toContain('const applyRunSettings = (next: {');
    expect(source).not.toContain('id="ai-seed-apply"');
    expect(source).not.toContain('id="ai-floor-apply"');
    expect(source).not.toContain('id="ai-scenario-apply"');
  });

  it('keeps run/manual controls in a themed sticky always-visible control dock', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');

    expect(source).toContain('Playback controls');
    expect(source).toContain('id="ai-playback-dock"');
    expect(source).toContain('position:sticky; top:8px; z-index:8;');
    expect(source).toContain('linear-gradient(180deg,#10172a,#0b1222)');
    expect(source).toContain('id="ai-toggle-run"');
    expect(source).toContain('id="ai-manual-toggle"');
    expect(source).toContain('id="ai-speed-1"');
    expect(source).toContain('id="ai-speed-4"');
    expect(source).toContain('id="ai-speed-16"');
  });
});
