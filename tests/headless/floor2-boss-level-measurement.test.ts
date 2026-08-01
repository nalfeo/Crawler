import { describe, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';

describe('Floor 2 boss level measurement (investigation)', () => {
  for (const seed of [1, 2, 3]) {
    it(`measures level at first boss encounter - seed ${seed}`, async () => {
      const stats = await runHeadless(new BehaviorTreeAI({ seed }), {
        seed,
        floorId: 'floor2',
        maxFrames: 300_000, // ~83 min at 60FPS
        questStallFrames: 60_000, // 1000s stall tolerance
      });
      
      const floor2 = stats.floor2Progression;
      console.log(`\nSeed ${seed}:`);
      if (floor2) {
        for (const [familyId, fam] of Object.entries(floor2.families)) {
          if (fam.encounterStartedMs !== null) {
            let levelAtBoss = 5;
            for (const lu of stats.levelUps) {
              if (lu.gameTimeMs <= fam.encounterStartedMs) {
                levelAtBoss = lu.level;
              }
            }
            console.log(`  Family ${familyId}: boss started at ${(fam.encounterStartedMs/1000).toFixed(1)}s, level=${levelAtBoss}`);
          } else {
            console.log(`  Family ${familyId}: boss NOT started`);
          }
        }
      }
      
      console.log(`  Final level: ${stats.finalLevel}, XP: ${stats.totalXp}`);
      console.log(`  Outcome: ${stats.outcome}${stats.stallReason ? ' ('+stats.stallReason+')' : ''}`);
      console.log(`  Game time: ${(stats.gameTimeMs / 1000).toFixed(1)}s`);
      console.log(`  Level ups: ${stats.levelUps.map(lu => `${lu.level}@${(lu.gameTimeMs/1000).toFixed(0)}s`).join(', ')}`);
    }, 300_000);
  }
});
