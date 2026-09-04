import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import {
  FLOOR3_COMPLETION_SEED,
  FLOOR3_COMPLETION_START_PLAYER_LEVEL,
} from '../helpers/floor3-completion-contract.js';

/**
 * Real-pipeline (`runHeadless` + production `BehaviorTreeAI`) Floor 3
 * completion evidence — the `floor-3-ai-runner-completion` epic's headless
 * hard gate (`docs/knowledge/epics/floor-3-ai-runner-completion/`).
 *
 * Unlike `tests/headless/floor3-poach-loadout.test.ts`'s Final Four test
 * (which uses `stopWhen` to force-knock-out every Studio/Final-Four roster
 * as a deterministic *telemetry-shape* contract check), this test drives
 * every Studio and Final Four fight through the REAL production combat
 * pipeline: `companionCombatSystem`'s auto-attacks, `companionKOSystem`'s
 * KO/recovery/wipe rules, and `BehaviorTreeAI`'s shared Floor 3 objective
 * navigation (`findFloor3ProgressObjective`). No `stopWhen`/`onFinish` hook
 * mutates combatants, goals, progression, or position, and nothing teleports
 * the player — the run is observed, not steered.
 *
 * This required a Floor-3-ONLY balance lever (human-authorized 2026-09-03):
 * the party's own Companions were structurally outnumbered (a lone level-1
 * starter vs. a multi-Companion Studio/Final-Four roster, all dealing
 * identical per-hit damage regardless of level — see `tuning.json`'s
 * `floor3Companion.starterLevel` / `playerCompanionHpMultiplier` /
 * `playerCompanionDamageMultiplier` notes and `companionCombatSystem.ts`).
 * Floors 1 and 2 are untouched by that change.
 *
 * Seed 3539 is the one committed deterministic seed that reaches victory
 * under the current tuning (an unmodified probe of this seed died at frame
 * 1,907 before the Floor-3-only companion buff/density tuning landed).
 * Passing this one seed proves possibility only — it is NOT a win-rate or
 * broad-balance claim (epic non-goals), and other seeds are not asserted
 * here.
 */
describe('floor3 production completion (real headless pipeline, no mutation)', () => {
  it(
    'completes Floor 3 via real BehaviorTreeAI combat: exits the entrance, clears all ' +
      '6 Studios, wins all 4 Final Four rounds, keeps a Companion, and reaches/confirms the exit',
    async () => {
      const stats = await runHeadless(new BehaviorTreeAI({ seed: FLOOR3_COMPLETION_SEED }), {
        seed: FLOOR3_COMPLETION_SEED,
        floorId: 'floor3',
        // Above the seed's observed completion frame (44,493) with headroom;
        // no stopWhen/onFinish hook touches the world — the run either
        // reaches the real victory/exit outcome on its own or it doesn't.
        maxFrames: 54000,
        questStallFrames: 0,
        // Floor-3-only, explicitly human-authorized "higher initial level"
        // lever (matches the precedent already set by
        // `floor3-poach-loadout.test.ts`'s Final Four test) — this is a
        // standard headless test config knob, not a runtime player cheat:
        // it only raises the AI-controlled player character's starting
        // level, the same as every other floor's headless tests do to skip
        // grind and focus the assertion on the system under test.
        startPlayerLevel: FLOOR3_COMPLETION_START_PLAYER_LEVEL,
      });

      expect(stats.outcome).toBe('victory');

      const progression = stats.floor3Progression;
      expect(progression).toBeDefined();
      // Left the protected spawn room under its own navigation.
      expect(progression?.leftEntrance).not.toBeNull();
      // All 6 selected Studios defeated.
      const studioVictories = progression?.studioVictories ?? {};
      const studioIds = Object.keys(studioVictories);
      expect(studioIds).toHaveLength(6);
      for (const studioId of studioIds) {
        expect(studioVictories[studioId], `Studio "${studioId}" never recorded a victory`).not.toBe(
          null,
        );
      }
      // All 4 ordered Final Four rounds defeated.
      const finalFourRounds = progression?.finalFourRounds ?? [];
      expect(finalFourRounds).toHaveLength(4);
      for (const round of finalFourRounds) {
        expect(
          round.victory,
          `Final Four round "${round.handlerId}" never recorded a victory`,
        ).not.toBeNull();
      }
      // A kept Companion was selected after the season win.
      expect(progression?.keptCompanionSelected).not.toBeNull();
      // The player actually arrived at the real exit stairs...
      expect(progression?.exitArrived).not.toBeNull();
      // ...and confirmed the descend from real interaction range.
      expect(progression?.exitCompleted).not.toBeNull();
    },
  );
});
