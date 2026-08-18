/**
 * Headless Floor 1 regression: the AI must actually USE its boss-chest drops.
 *
 * Every Floor 1 boss chest rewards a Wave-A weapon (see
 * `BOSS_CHEST_REWARD_BASE_IDS` in `src/game/boss-chest-resolver.ts`), and those
 * weapons all target `mainHand` — the slot the static starter weapon occupies
 * for the entire floor. The settlement-maintenance planner used to treat every
 * slot held by a static item as permanently protected, so 100% of Floor 1 chest
 * rewards were claimed, bagged, and then never equipped: a real run ended with
 * `equippedGeneratedCount === 0` on every seed sampled (1–12).
 *
 * This asserts the outcome in the REAL headless pipeline (not a lab): after a
 * Floor 1 clear that claimed both boss chests, at least one generated item is
 * equipped. It deliberately does not assert *which* weapon wins — that is the
 * evaluator's scored decision — only that the AI is capable of accepting a
 * chest drop at all.
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_MAX_FRAMES,
  GATE_WALL_TIME_CAP_MS,
} from '../../scripts/agent/perf/floor1-gate-sample.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import type { RunStats } from '../../src/game/ai/types.js';

/**
 * Small contiguous seed prefix. Each seed is deterministic, so this is a
 * regression sample rather than a statistical one; a contiguous prefix cannot
 * be gamed by hand-picking comfortable seeds (AGENTS.md r12).
 */
const SEEDS = [1, 2, 3] as const;

const HOOK_TIMEOUT_MS = SEEDS.length * 180_000;

async function runFloor1(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ ...getPersonaConfig('experienced_player'), seed });
  return runHeadless(ai, {
    seed,
    maxFrames: GATE_MAX_FRAMES,
    maxWallTimeMs: GATE_WALL_TIME_CAP_MS,
    playerPersona: 'experienced_player',
  });
}

describe('Floor 1 boss-chest drops are usable by the AI', () => {
  it(
    'equips at least one generated item after claiming its boss chests',
    async () => {
      const summaries: string[] = [];
      let equippedSeeds = 0;
      for (const seed of SEEDS) {
        const stats = await runFloor1(seed);
        const metrics = stats.equipmentPlayability;
        if (!metrics) {
          throw new Error(`seed ${seed} did not report equipment playability metrics`);
        }
        summaries.push(
          `seed ${seed}: outcome=${stats.outcome} equipped=${metrics.equippedGeneratedCount} ` +
            `bagged=${metrics.baggedGeneratedCount} unopenedRewardBoxes=${metrics.unopenedRewardBoxes}`,
        );
        // Only seeds that actually reached and claimed the boss chests can
        // demonstrate the behaviour; a lost run has nothing to equip.
        if (stats.outcome !== 'victory') continue;
        expect(
          metrics.baggedGeneratedCount + metrics.equippedGeneratedCount,
          `seed ${seed} claimed no generated equipment at all — ${summaries.join(' | ')}`,
        ).toBeGreaterThan(0);
        if (metrics.equippedGeneratedCount > 0) equippedSeeds += 1;
      }
      console.log(`[floor1-boss-chest-equip] ${summaries.join(' | ')}`);
      expect(
        equippedSeeds,
        `no sampled Floor 1 seed equipped a generated boss-chest drop — ${summaries.join(' | ')}`,
      ).toBeGreaterThan(0);
    },
    HOOK_TIMEOUT_MS,
  );
});
