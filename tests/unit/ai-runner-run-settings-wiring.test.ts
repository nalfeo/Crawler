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

  it('keeps expert run controls in a compact sticky command deck', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');

    expect(source).toContain('id="ai-playback-dock"');
    expect(source).toContain('.runner-command-deck');
    expect(source).toContain('position: sticky;');
    expect(source).toContain('id="ai-toggle-run"');
    expect(source).toContain('id="ai-manual-toggle"');
    expect(source).toContain('id="ai-restart-current"');
    expect(source).toContain('id="ai-speed-1"');
    expect(source).toContain('id="ai-speed-4"');
    expect(source).toContain('id="ai-speed-16"');
    expect(source).toContain('aria-pressed="${selectedSpeed === 1}"');
  });

  it('separates restart-current from applying staged run settings', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');

    expect(source).toContain('Restarted the currently applied run.');
    expect(source).toContain('Apply staged + restart');
    expect(source).toContain('stagedSeedText');
    expect(source).toContain('stagedRunTarget');
  });

  it('does not frame-step when focus is inside any interactive control', () => {
    const source = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');

    expect(source).toContain(
      '\'button, input, select, textarea, summary, a, [contenteditable="true"], [role="button"]\'',
    );
  });
});
