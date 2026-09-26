/**
 * Floor 4 Headliner survival gate (issue #4519).
 *
 * Headliners must live through their own first telegraph and resolution. This
 * uses the production AI pipeline and catalog timings rather than an HP-only
 * assertion, so a progression or income change cannot silently turn a boss
 * back into a one-volley kill.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { getPersonaConfig } from '../../src/game/ai/personas.js';
import { FLOOR4_BOSS_ABILITY_CATALOG } from '../../src/shared/boss-abilities.js';

const SEED = 404;
const MAX_FRAMES = 60_000;
const MAX_WALL_TIME_MS = 180_000;
const MAX_HEADLINER_FIGHT_MS = 30_000;

const FIRST_CAST_MS_BY_ARCHETYPE = new Map(
  FLOOR4_BOSS_ABILITY_CATALOG.entries.map((ability) => [
    ability.bossArchetypeId,
    ability.timing.firstEligibleAfterMs + ability.telegraph.durationMs,
  ]),
);

describe('Floor 4 Headliner survival gate — every encounter resolves its opening mechanic', () => {
  it('keeps the canonical production run viable while each Headliner survives its first cast', async () => {
    const stats = await runHeadless(
      new BehaviorTreeAI({ ...getPersonaConfig('experienced_player'), seed: SEED }),
      {
        seed: SEED,
        floorId: 'floor4',
        maxFrames: MAX_FRAMES,
        maxWallTimeMs: MAX_WALL_TIME_MS,
        playerPersona: 'experienced_player',
      },
    );
    const arena = stats.floor4Arena;
    expect(arena, 'Floor 4 run did not emit arena telemetry').toBeDefined();
    expect(stats.outcome, `seed ${SEED} must remain completable`).toBe('victory');
    expect(arena!.headlinerTelemetry.fights).toHaveLength(arena!.headlinerCard.length);

    for (const fight of arena!.headlinerTelemetry.fights) {
      const requiredMs = FIRST_CAST_MS_BY_ARCHETYPE.get(fight.archetypeId);
      if (requiredMs === undefined) {
        throw new Error(`Headliner '${fight.archetypeId}' has no authored ability timing`);
      }
      expect(fight.defeatedAtWorldElapsedMs).not.toBeNull();
      const durationMs = fight.defeatedAtWorldElapsedMs! - fight.startedAtWorldElapsedMs;
      const context = `act=${fight.act} archetype=${fight.archetypeId} durationMs=${Math.round(durationMs)}`;
      expect(
        durationMs,
        `${context} died before its ${requiredMs}ms opening mechanic`,
      ).toBeGreaterThanOrEqual(requiredMs);
      expect(durationMs, `${context} exceeded the 30s headline window`).toBeLessThanOrEqual(
        MAX_HEADLINER_FIGHT_MS,
      );
    }
  }, 60_000);
});
