import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { BehaviorTreeAI, getPersonaConfig } from '../../src/game/ai/index.js';

describe('Floor 5 production-controller route', () => {
  it('completes the siege from the manifest default state without test hooks or forced loadout', async () => {
    const stats = await runHeadless(
      new BehaviorTreeAI({ ...getPersonaConfig('experienced_player'), seed: 505 }),
      {
        floorId: 'floor5',
        seed: 505,
        maxFrames: 12_000,
        questStallFrames: 1_200,
      },
    );

    expect(stats.outcome).toBe('victory');
    expect(stats.startingWeapon).toBe('throwing-knife');
    expect(stats.floor5Siege).toMatchObject({
      phase: { kind: 'CAPTURED' },
      tasks: {
        openingPushRepelled: true,
        yardSecured: true,
        componentsReady: true,
        checkpointCleared: true,
      },
      engineState: 'BREACHED',
      breachState: 'BREACHED',
    });
    expect(stats.floor5Siege?.construction).toMatchObject({ attempts: 2, deniedAttempts: 0 });
    expect(stats.floor5Siege?.finale).toMatchObject({
      captured: true,
      rejectedCaptureAttempts: 0,
    });
  }, 120_000);
});
