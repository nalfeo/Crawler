import { describe, expect, it } from 'vitest';

import { decompose, renderTriage, triage, validateDecomposition } from '../../scripts/agent/producer';

// ---------------------------------------------------------------------------
// triage() — six classification paths
// ---------------------------------------------------------------------------

describe('triage()', () => {
  it('classifies game-balancing requests with quantitative signals', () => {
    const result = triage('Reduce spawn rates for playtesting');
    expect(result.requestType).toBe('GAME_BALANCING');
    expect(result.verdict).toBe('RISKY');
    expect(result.escalation).toBe('HUMAN_GATE');
  });

  it('does NOT classify "damage popup" as GAME_BALANCING (no quantitative signal)', () => {
    const result = triage('Add a damage number popup above enemies');
    expect(result.requestType).not.toBe('GAME_BALANCING');
  });

  it('does NOT classify "damage log UI" as GAME_BALANCING', () => {
    const result = triage('Create a damage log UI for the HUD');
    expect(result.requestType).not.toBe('GAME_BALANCING');
  });

  it('classifies debugging requests', () => {
    const result = triage('Player can walk through walls on Floor 2');
    expect(result.requestType).toBe('DEBUGGING');
    expect(result.verdict).toBe('RECOMMENDED');
    expect(result.escalation).toBeUndefined();
  });

  it('classifies crash reports as DEBUGGING', () => {
    const result = triage('Game crash when entering the shop');
    expect(result.requestType).toBe('DEBUGGING');
  });

  it('classifies investigation requests', () => {
    const result = triage('Investigate why loot tables are biased');
    expect(result.requestType).toBe('INVESTIGATION');
  });

  it('classifies feature requests', () => {
    const result = triage('Add a bowling minigame');
    expect(result.requestType).toBe('FEATURE');
  });

  it('classifies chore/refactor requests', () => {
    const result = triage('Refactor the loot table format');
    expect(result.requestType).toBe('CHORE');
  });

  it('returns UNCLEAR for ambiguous input', () => {
    const result = triage('xyz123');
    expect(result.requestType).toBe('UNCLEAR');
    expect(result.verdict).toBe('NOT_RECOMMENDED');
    expect(Array.isArray(result.questions)).toBe(true);
  });

  it('prioritizes GAME_BALANCING over feature keywords when balance + metric present', () => {
    const result = triage('Update spawn rates to 80% for playtesting');
    expect(result.requestType).toBe('GAME_BALANCING');
  });

  it('does not classify "bug in newly added feature" as DEBUGGING when feature keywords dominate', () => {
    // Feature keywords (add/new) suppress DEBUGGING detection — this is intentional
    const result = triage('There is a bug in the newly added loot system');
    // Falls through to FEATURE because feature keywords override the debug exclusion
    expect(result.requestType).toBe('FEATURE');
  });
});

describe('renderTriage()', () => {
  it('includes the user-visible verdict line for feature requests', () => {
    const output = renderTriage('Add a bowling minigame');
    expect(output).toContain('Type: FEATURE');
    expect(output).toContain(
      'Verdict: RECOMMENDED — A feature request is reasonable to plan, but it still needs scope clarification first.',
    );
  });
});

// ---------------------------------------------------------------------------
// decompose() — persona mapping, dependencies, parallelizable groups
// ---------------------------------------------------------------------------

describe('decompose()', () => {
  it('returns a result with slices, totalApples, criticalPath, and parallelizableGroups', () => {
    const result = decompose('Add loot drop animations and sound effects');
    expect(Array.isArray(result.slices)).toBe(true);
    expect(typeof result.totalApples).toBe('number');
    expect(Array.isArray(result.criticalPath)).toBe(true);
    expect(Array.isArray(result.parallelizableGroups)).toBe(true);
  });

  it('maps graphics systems to Graphics Designer', () => {
    const result = decompose('Add visual particle effects for combat hits');
    const graphicsSlice = result.slices.find((s) => s.persona === 'Graphics Designer');
    expect(graphicsSlice).toBeDefined();
  });

  it('maps audio systems to Sound Designer', () => {
    const result = decompose('Add sound effects for loot drops');
    const audioSlice = result.slices.find((s) => s.persona === 'Sound Designer');
    expect(audioSlice).toBeDefined();
  });

  it('maps combat systems to Game Designer', () => {
    const result = decompose('Implement a new attack combo system');
    const gameSlice = result.slices.find((s) => s.persona === 'Game Designer');
    expect(gameSlice).toBeDefined();
  });

  it('maps AI systems to Systems Engineer', () => {
    const result = decompose('Improve enemy pathfinding behavior');
    const sysSlice = result.slices.find((s) => s.persona === 'Systems Engineer');
    expect(sysSlice).toBeDefined();
  });

  it('caps apple tier at 3 for slices with many systems', () => {
    // A request that touches many systems in one persona
    const result = decompose('Add combat loot progression economy for new floor');
    for (const slice of result.slices) {
      expect(slice.apples).toBeLessThanOrEqual(3);
    }
  });

  it('assigns 2 apples for slices with 1-2 systems', () => {
    const result = decompose('Add particle effects for hits');
    const graphicsSlice = result.slices.find((s) => s.persona === 'Graphics Designer');
    if (graphicsSlice && graphicsSlice.systems.length <= 2) {
      expect(graphicsSlice.apples).toBe(2);
    }
  });

  it('UI slices depend on core (Game Designer / Systems Engineer) slices', () => {
    const result = decompose('Add a HUD health bar with combat integration');
    const uiSlice = result.slices.find((s) => s.persona === 'UX Designer');
    const coreSlices = result.slices.filter((s) =>
      ['Game Designer', 'Systems Engineer'].includes(s.persona),
    );
    if (uiSlice && coreSlices.length > 0) {
      expect(uiSlice.dependencies.length).toBeGreaterThan(0);
    }
  });

  it('criticalPath contains only root slices (zero dependencies)', () => {
    const result = decompose('Add loot drop animations and sound effects');
    for (const id of result.criticalPath) {
      const slice = result.slices.find((s) => s.id === id);
      expect(slice?.dependencies.length).toBe(0);
    }
  });

  it('parallelizableGroups cover all slices exactly once', () => {
    const result = decompose('Add a new boss with custom AI and loot rewards');
    const allGrouped = result.parallelizableGroups.flat();
    const allSliceIds = result.slices.map((s) => s.id).sort();
    expect(allGrouped.sort()).toEqual(allSliceIds);
  });

  it('floor-generation routes only to Game Designer, not Content Designer', () => {
    const result = decompose('Generate new floor rooms with wave spawns');
    const gameSlice = result.slices.find((s) => s.persona === 'Game Designer');
    const contentSlice = result.slices.find((s) => s.persona === 'Content Designer');
    expect(gameSlice).toBeDefined();
    // Content Designer should only appear if 'quests' is detected
    expect(contentSlice).toBeUndefined();
  });

  it('quests routes to Content Designer', () => {
    const result = decompose('Add a new quest with objectives and rewards');
    const contentSlice = result.slices.find((s) => s.persona === 'Content Designer');
    expect(contentSlice).toBeDefined();
  });

  it('totalApples equals sum of all slice apple tiers', () => {
    const result = decompose('Add combat loot and audio');
    const expected = result.slices.reduce((s, sl) => s + sl.apples, 0);
    expect(result.totalApples).toBe(expected);
  });

  it('requires a measurable hard gate before delegation', () => {
    const result = decompose('Add a new boss with custom AI and loot rewards');
    expect(result.contract.gateStatus).toBe('MISSING');
    expect(result.contract.readyForDelegation).toBe(false);
    expect(result.contract.rankedTiebreakers).toHaveLength(3);
  });

  it('does not treat a gameplay parameter as a success gate', () => {
    const result = decompose('Add a boss that spawns every 30 seconds');
    expect(result.contract.gateStatus).toBe('MISSING');
    expect(result.contract.readyForDelegation).toBe(false);
  });

  it('accepts a measurable hard gate and exposes confidence', () => {
    const result = decompose('Add a boss and reach 90% win rate across 100 runs');
    expect(result.contract.gateStatus).toBe('READY');
    expect(result.contract.readyForDelegation).toBe(true);
    expect(result.contract.confidence).toBeGreaterThanOrEqual(0.8);
    expect(validateDecomposition(result)).toEqual([]);
  });

  it('does not emit duplicate or dangling dependencies', () => {
    const result = decompose('Add a new boss with custom AI and loot rewards');
    const ids = new Set(result.slices.map((slice) => slice.id));
    for (const slice of result.slices) {
      expect(slice.dependencies).not.toContain(slice.id);
      for (const dependency of slice.dependencies) expect(ids).toContain(dependency);
    }
  });

  it('routes pure mechanics without inventing runtime plumbing', () => {
    const result = decompose('Implement a new attack combo system');
    expect(result.slices.find((slice) => slice.persona === 'Game Designer')).toBeDefined();
    expect(result.slices.find((slice) => slice.persona === 'Systems Engineer')).toBeUndefined();
  });
});
