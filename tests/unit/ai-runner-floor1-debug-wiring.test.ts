import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI runner Floor 1 debug wiring', () => {
  it('renders Floor 1 debug controls and wires jump/reveal/quest handlers', () => {
    // Intentional canary test: this follows existing ai-runner wiring guards that
    // read the source file and assert critical integration strings.
    const source = readFileSync(
      new URL('../../src/labs/ai-runner-lab/index.ts', import.meta.url),
      'utf-8',
    );

    expect(source).toContain('Floor 1 Debug');
    expect(source).toContain('id="ai-jump-target"');
    expect(source).toContain('id="ai-jump-now"');
    expect(source).toContain('id="ai-show-all-rooms"');
    expect(source).toContain('id="ai-quest-target"');
    expect(source).toContain('id="ai-quest-action"');
    expect(source).toContain('id="ai-quest-apply"');

    expect(source).toMatch(/startFloor1BossEncounter\(world,\s*playerEid\)/);
    expect(source).toMatch(/setDebugFlag\?\.\('showAllRooms',\s*floorDebug\.showAllRooms\)/);
    expect(source).toMatch(/acceptQuest\(world,\s*floorDebug\.questId\)/);
    expect(source).toMatch(/setTrackedQuest\(world,\s*floorDebug\.questId\)/);
    expect(source).toMatch(/setGoalFlag\(world,\s*objective\.goalId,\s*true\)/);
    expect(source).toMatch(/questSystem\(world\)/);
  });
});
