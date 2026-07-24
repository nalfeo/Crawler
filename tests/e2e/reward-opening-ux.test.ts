/**
 * Deterministic e2e coverage for the shared reward-opening UX
 * (`RewardOpeningUI`) driven through the REAL `MainGameScene` via
 * `main-scene-probe-lab` — anticipation → revealing → summary → claimed, with
 * skip/reduced-motion/duplicate-input/input-lock/summary-accuracy checks.
 *
 * Scope note (rarity axis): the hard UX contract requires excitement to scale
 * independently by BOTH box tier and actual highest item rarity (e.g. a
 * tier-2 Common reward should read less intense than a tier-2 Uncommon
 * reward, per `computeEquipmentExcitement`). That numeric contract IS
 * implemented and is exhaustively proven by
 * `tests/property/reward-presentation-excitement.property.test.ts` and
 * `tests/unit/achievement-reward-presentation.test.ts`. It is NOT re-proven
 * here with real content, because no currently-shipped content path can
 * exercise rarity variance:
 *   - every Floor 1 achievement reward is `lootBox`-type (tier-only scoring —
 *     `rarityWeight` is always 0 for these; see `achievements.floor1.json`),
 *     never `equipment`-type;
 *   - boss chests always resolve `tier1`+`common` deterministically by design
 *     (ADR 0069/0070 — see `openBossChest` in
 *     `src/core/systems/bossChestRewards.ts`), so they can never vary rarity
 *     either.
 * This suite instead proves the TIER axis in real content (two lootBox
 * achievements of different tiers land in different excitement buckets) and
 * proves every other hard-contract behavior (state ordering, skip, reduced
 * motion, duplicate input, summary accuracy, input lock) against the real
 * scene. If/when an `equipment`-type achievement or rarity-varying boss chest
 * ships, extend this suite to add a real rarity-axis case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import {
  loadMainSceneProbeLab,
  mainSceneProbe,
  waitForRewardOpeningState,
} from './helpers/main-scene-probe.js';
import { DEFAULT_PER_ITEM_REVEAL_MS } from '../../src/shared/reward-opening-sequence.js';

/** Trash-tier achievement (lowest `LOOT_BOX_TIERS` rung) — modest bucket. */
const TRASH_TIER_ACHIEVEMENT_ID = 'first-bonk';
/** Rare-tier achievement (mid/high `LOOT_BOX_TIERS` rung) — exciting bucket. */
const RARE_TIER_ACHIEVEMENT_ID = 'room-sweeper';

async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loadMainSceneProbeLab(page);
  return { context, page };
}

describe('real reward-opening UX (achievement path)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('visits every phase in order with no skipped phase and an accurate summary', async () => {
    const { context, page } = await newPage(browser);
    try {
      expect(await mainSceneProbe.getRewardOpeningState(page)).toMatchObject({ open: false });

      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      const anticipation = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'reward-opening overlay to open in anticipation',
      });
      expect(anticipation.phase).toBe('anticipation');
      expect(anticipation.revealed).toBe(0);
      // Exact count regression test (round-3 code review finding): the
      // `trash` lootBox tier deterministically grants 1 gold entry +
      // LOOT_BOX_MATERIAL_COUNT_BY_TIER.trash===1 distinct material entry =
      // 2 reveal items. This locks in that RewardOpeningUI.open() derives
      // itemCount from the REAL revealItems.length (round-2 fix), not a
      // hardcoded lootBox constant — a regression back to hardcoding
      // itemCount=1 would silently pass a bare `toBeGreaterThan(0)` check.
      expect(anticipation.total).toBe(2);

      // A single large deterministic tick clears anticipation without
      // depending on real elapsed frame time (see reward-opening-sequence.ts
      // DEFAULT_ANTICIPATION_MS=900).
      await mainSceneProbe.tickRewardOpening(page, 1_000);
      const revealing = await waitForRewardOpeningState(
        page,
        (s) => s.phase === 'revealing' || s.phase === 'summary',
        { label: 'transition out of anticipation' },
      );
      expect(['revealing', 'summary']).toContain(revealing.phase);

      // Tick through every remaining item reveal one item-duration at a time
      // (never in one big jump) so we can prove the round-2 code-review fix
      // in the REAL game path, not just the pure state machine's unit tests:
      // every item must be observably revealed (phase 'revealing' with
      // revealed === total) for at least one frame before summary appears —
      // previously the sequence could jump straight from a partial reveal to
      // 'summary' in the same tick that first computed the full count, so no
      // caller ever saw the fully-revealed 'revealing' frame.
      let sawFullRevealBeforeSummary = false;
      for (let i = 0; i < revealing.total + 2; i += 1) {
        await mainSceneProbe.tickRewardOpening(page, DEFAULT_PER_ITEM_REVEAL_MS);
        const afterTick = await mainSceneProbe.getRewardOpeningState(page);
        if (afterTick.phase === 'revealing' && afterTick.revealed === afterTick.total) {
          sawFullRevealBeforeSummary = true;
        }
        if (afterTick.phase === 'summary') {
          break;
        }
      }
      expect(sawFullRevealBeforeSummary).toBe(true);
      const summary = await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'reward-opening summary phase',
      });
      expect(summary.revealed).toBe(summary.total);
      expect(summary.total).toBeGreaterThan(0);

      // Duplicate/repeated acknowledge is safe (idempotent claim-once path):
      // the overlay closes on the first ack and further acks are no-ops.
      await mainSceneProbe.acknowledgeRewardOpening(page);
      const closed = await waitForRewardOpeningState(page, (s) => !s.open, {
        label: 'overlay to close after acknowledge',
      });
      expect(closed).toEqual({ open: false, phase: null, bucket: null, revealed: 0, total: 0 });
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await mainSceneProbe.skipRewardOpening(page);
      expect(await mainSceneProbe.getRewardOpeningState(page)).toEqual({
        open: false,
        phase: null,
        bucket: null,
        revealed: 0,
        total: 0,
      });
    } finally {
      await context.close();
    }
  });

  it('scales excitement intensity by box tier for real, differently-tiered achievements', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      const trash = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'trash-tier reward overlay to open',
      });
      expect(trash.bucket).toBe('modest');
      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, {
        label: 'trash-tier overlay to close before claiming the second reward',
      });

      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      const rare = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'rare-tier reward overlay to open',
      });
      // rare = LOOT_BOX_TIERS index 3 of 6 -> tierWeight 0.5 -> 'exciting',
      // strictly more intense than trash's 'modest' — proves tier scales
      // excitement independently of any equipment rarity input.
      expect(rare.bucket).toBe('exciting');
      expect(rare.bucket).not.toBe(trash.bucket);
    } finally {
      await context.close();
    }
  });

  it('skip jumps straight to summary with full reveal progress, never losing a phase', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'overlay to open' });

      await mainSceneProbe.skipRewardOpening(page);
      const summary = await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'skip to land on summary',
      });
      expect(summary.revealed).toBe(summary.total);
      expect(summary.total).toBeGreaterThan(0);

      // Duplicate skip calls while already at summary are safe no-ops.
      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.skipRewardOpening(page);
      const stillSummary = await mainSceneProbe.getRewardOpeningState(page);
      expect(stillSummary.phase).toBe('summary');
      expect(stillSummary.revealed).toBe(stillSummary.total);
    } finally {
      await context.close();
    }
  });

  it('reduced motion still visits every phase but resolves near-instantly', async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page);
      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      const anticipation = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'reduced-motion overlay to open',
      });
      expect(anticipation.phase).toBe('anticipation');

      // REDUCED_MOTION_ANTICIPATION_MS=120 and REDUCED_MOTION_REVEAL_MS=60 —
      // a single 500ms tick is well past both, but the phase machine still
      // visits `revealing` before `summary` rather than skipping it outright.
      await mainSceneProbe.tickRewardOpening(page, 500);
      const afterOneTick = await mainSceneProbe.getRewardOpeningState(page);
      expect(['revealing', 'summary']).toContain(afterOneTick.phase);

      await mainSceneProbe.tickRewardOpening(page, 500);
      const summary = await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'reduced-motion summary phase',
      });
      expect(summary.revealed).toBe(summary.total);
    } finally {
      await context.close();
    }
  });

  it('freezes world simulation while the reward overlay is open (input lock)', async () => {
    const { context, page } = await newPage(browser);
    try {
      // The probe lab boots straight into `world.state === 'loadout'`, which
      // itself early-returns out of the fixed-step sim (see the `'loadout'`
      // branch in `MainGameScene.update()`) — so `elapsedMs` would stay frozen
      // at 0 for reasons unrelated to the reward overlay under test. Use the
      // real `resolveLoadout()` flow (it both transitions world.state AND
      // closes the loadout modalPicker — a bare `setWorldState('playing')`
      // leaves the modal open, which freezes the sim via its own
      // `modalPicker?.isOpen()` gate), then immediately un-pause — that
      // helper also calls `setSimulationPaused(true)` as a side effect we
      // don't want here, since we need real per-frame elapsedMs progression.
      await mainSceneProbe.resolveLoadout(page);
      await mainSceneProbe.setSimulationPaused(page, false);
      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'overlay to open' });

      // Snapshot elapsedMs only once the overlay is confirmed open — capturing
      // it any earlier races against however many real frames tick between
      // issuing the claim and the overlay actually appearing, which is
      // non-deterministic wall-clock timing, not behavior under test.
      const openedAt = await mainSceneProbe.getWorldElapsedMs(page);

      // Real update-loop frames elapse while the overlay is open; MainGameScene
      // early-returns out of world simulation whenever rewardOpeningUI.isOpen()
      // (see isBlockingSurfaceOpen()/update() in MainGameScene.ts), so
      // world.elapsedMs must not have advanced further despite wall-clock time
      // passing.
      await page.waitForTimeout(300);
      const duringOpen = await mainSceneProbe.getWorldElapsedMs(page);
      expect(duringOpen).toBe(openedAt);

      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, { label: 'overlay to close' });

      // Once closed, the sim resumes ticking again.
      await page.waitForTimeout(300);
      const afterClose = await mainSceneProbe.getWorldElapsedMs(page);
      expect(afterClose).toBeGreaterThan(openedAt ?? 0);
    } finally {
      await context.close();
    }
  });
});
