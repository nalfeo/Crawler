import { describe, expect, it } from 'vitest';
import { checkFloor1SetPieceReachability } from '../../src/game/set-piece-reachability.js';

/**
 * Local smoke panel for the prefab set-piece reachability hard gate: the carved
 * welcome-room must be reachable from spawn with every door + NPC anchor pathable
 * on every seed. The broad zero-tolerance sweep (>10 runs) runs in CI via
 * `.github/workflows/set-piece-reachability.yml`; this panel gives fast local
 * feedback and guards against regressions in `npm run verify`. Seeds are a fixed
 * deterministic panel — NO cherry-picking (rule #12): a single sealed room here
 * is a real bug, not a seed to swap out.
 */
const SEED_PANEL = [1, 2, 3, 7, 19, 32, 42, 100, 777, 2024] as const;

describe('Floor 1 set-piece reachability (prefab welcome-room)', () => {
  for (const seed of SEED_PANEL) {
    it(`seed ${seed}: welcome-room reachable with all doors + NPC anchors pathable`, () => {
      const result = checkFloor1SetPieceReachability(seed);
      expect(
        result.pass,
        `seed ${seed} failed reachability:\n  - ${result.failures.join('\n  - ')}`,
      ).toBe(true);
      // Sanity: the carve must produce a real shell (>= 1 door) and keep the
      // hub's NPC anchors inside the room.
      expect(result.doorCount, `seed ${seed}: expected >= 1 door`).toBeGreaterThanOrEqual(1);
      expect(
        result.npcCount,
        `seed ${seed}: expected >= 1 in-room NPC anchor`,
      ).toBeGreaterThanOrEqual(1);
    });
  }
});
