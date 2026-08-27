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
 * exercise rarity variance in a quick non-headless game-UI run:
 *   - every Floor 1 achievement reward is `lootBox`-type (tier-only scoring —
 *     `rarityWeight` is always 0 for these; see `achievements.floor1.json`),
 *     never `equipment`-type;
 *   - boss chests resolve `tier4` (85% Uncommon / 15% Rare per PLAN.md §E3-C)
 *     (ADR 0069/0070 — see `openBossChest` in
 *     `src/core/systems/bossChestRewards.ts`), so rarity variance is real but
 *     requires a headless run to exercise (see boss-chest-lifecycle.test.ts).
 * This suite instead proves the TIER axis in real content (two lootBox
 * achievements of different tiers land in different excitement buckets) and
 * proves every other hard-contract behavior (state ordering, skip, reduced
 * motion, duplicate input, summary accuracy, input lock) against the real
 * scene. If/when an `equipment`-type achievement ships, extend this suite
 * to add a real rarity-axis case with live game-UI content.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { boundsCenterScreen, closeQuietly, getCanvasRect } from './helpers/ui-probe.js';
import {
  loadMainSceneProbeLab,
  mainSceneProbe,
  waitForState,
  waitForRewardOpeningState,
} from './helpers/main-scene-probe.js';
import { DEFAULT_PER_ITEM_REVEAL_MS } from '../../src/shared/reward-opening-sequence.js';

/** Trash-tier achievement (lowest `LOOT_BOX_TIERS` rung) — modest bucket. */
const TRASH_TIER_ACHIEVEMENT_ID = 'first-bonk';
/** Rare-tier achievement (mid/high `LOOT_BOX_TIERS` rung) — exciting bucket. */
const RARE_TIER_ACHIEVEMENT_ID = 'room-sweeper';
const REWARD_OPENING_AUTO_HOLD_FRAMES = 60;

async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loadMainSceneProbeLab(page);
  return { context, page };
}

/**
 * Drive an already-open reward-opening overlay forward, one item-reveal
 * duration at a time, until it reaches `summary`. Mirrors the tick loop used
 * by the pre-existing "visits every phase in order" test — `tick()` only
 * fires one `onItemRevealed`/phase-transition step per call near a boundary,
 * so a single oversized tick can land exactly on the last revealed item
 * without also completing the revealing→summary transition in the same call.
 */
async function advanceRewardOpeningToSummary(page: Page, itemCount: number): Promise<void> {
  await mainSceneProbe.tickRewardOpening(page, 1_000);
  for (let i = 0; i < itemCount + 2; i += 1) {
    const state = await mainSceneProbe.getRewardOpeningState(page);
    if (state.phase === 'summary') return;
    await mainSceneProbe.tickRewardOpening(page, DEFAULT_PER_ITEM_REVEAL_MS);
  }
  await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
    label: 'summary phase',
  });
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
      expect(closed).toEqual({
        open: false,
        phase: null,
        bucket: null,
        revealed: 0,
        total: 0,
        nextLabel: null,
      });
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await mainSceneProbe.skipRewardOpening(page);
      expect(await mainSceneProbe.getRewardOpeningState(page)).toEqual({
        open: false,
        phase: null,
        bucket: null,
        revealed: 0,
        total: 0,
        nextLabel: null,
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

  it('renders and equips the exact generated Floor 2 achievement reward through inventory', async () => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor2' });
      await mainSceneProbe.resolveLoadout(page);
      await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
        label: 'Floor 2 loadout resolved',
      });
      await mainSceneProbe.unlockSafeRoomSurfaces(page);
      await waitForState(page, (state) => state.safeContext, {
        label: 'Floor 2 inventory surface unlocked',
      });

      const grantedInstanceKeys = await mainSceneProbe.claimAchievementReward(
        page,
        'floor2-safe-harbor',
      );
      expect(
        grantedInstanceKeys,
        'claiming the Floor 2 loot box should identify its immutable generated reward',
      ).toHaveLength(1);
      const instanceKey = grantedInstanceKeys[0];
      if (!instanceKey) return;

      await waitForRewardOpeningState(page, (state) => state.open, {
        label: 'Floor 2 reward-opening overlay',
      });
      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (state) => !state.open, {
        label: 'Floor 2 reward-opening overlay closed',
      });

      await mainSceneProbe.requestInventoryToggle(page);
      await waitForState(page, (state) => state.inventoryOpen, {
        label: 'inventory open after achievement claim',
      });
      const cell = await mainSceneProbe.getGeneratedInventoryCellBounds(page, instanceKey);
      expect(
        cell,
        'claimed generated equipment must be visible in the rendered inventory grid',
      ).not.toBeNull();
      if (!cell) return;

      const center = boundsCenterScreen(
        await getCanvasRect(page),
        { width: 1280, height: 720 },
        cell,
      );
      await page.mouse.dblclick(center.x, center.y);
      await expect
        .poll(() => mainSceneProbe.getEquippedGeneratedInstanceKeys(page), {
          message: 'double-click should equip the exact achievement reward instance',
        })
        .toContain(instanceKey);
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

  it('auto-acknowledges the summary only after the auto-driven hold threshold', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.resolveLoadout(page);
      await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
        label: 'loadout resolved before reward auto-driver coverage',
      });

      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      const autoReward = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'auto-driven reward overlay to open',
      });
      await advanceRewardOpeningToSummary(page, autoReward.total);
      const summary = await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'auto-driven reward summary',
      });
      expect(summary.open).toBe(true);

      const autoSamples = await mainSceneProbe.sampleAutoDrivenRewardOpeningRenderFrames(
        page,
        REWARD_OPENING_AUTO_HOLD_FRAMES - 1,
        1,
      );
      const beforeThreshold = autoSamples.first;
      expect(beforeThreshold.phase).toBe('summary');
      expect(beforeThreshold.open).toBe(true);

      // `driveAutoRewardOpening()` calls `acknowledge()` synchronously inside
      // the same render update that reaches the hold threshold.
      const atThreshold = autoSamples.next;
      expect(atThreshold).toEqual({
        open: false,
        phase: null,
        bucket: null,
        revealed: 0,
        total: 0,
        nextLabel: null,
      });

      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      const manualReward = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'manual-mode reward overlay to open',
      });
      await advanceRewardOpeningToSummary(page, manualReward.total);
      expect(await mainSceneProbe.isRewardOpeningAutoDrivenForProbe(page)).toBe(false);

      const manualAfterThreshold = await mainSceneProbe.advanceRewardOpeningRenderFrames(
        page,
        REWARD_OPENING_AUTO_HOLD_FRAMES,
      );
      expect(manualAfterThreshold.phase).toBe('summary');
      expect(manualAfterThreshold.open).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('opens the next achievement box back to back from the summary screen', async () => {
    const { context, page } = await newPage(browser);
    try {
      // A second unlocked-but-unclaimed loot-box achievement is what makes the
      // chain affordance appear at all.
      await mainSceneProbe.unlockAchievement(page, RARE_TIER_ACHIEVEMENT_ID);
      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'first overlay open' });
      await mainSceneProbe.skipRewardOpening(page);

      const summary = await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'first summary',
      });
      expect(summary.nextLabel).toBe('rare box');

      // Driven through REAL keyboard input, not the probe, so the `[N]`
      // keydown wiring in RewardOpeningUI is itself covered end to end.
      await page.keyboard.press('n');
      // The overlay never returns to the panel: it re-opens directly on the
      // next box's anticipation phase.
      const chained = await waitForRewardOpeningState(page, (s) => s.phase === 'anticipation', {
        label: 'chained next box open',
      });
      expect(chained.open).toBe(true);
      // `room-sweeper` is the `rare` tier -> 1 gold entry + 3 material entries,
      // a different reveal shape than the trash box that preceded it, proving
      // this really is the NEXT box and not a redisplay of the first.
      expect(chained.total).toBeGreaterThan(summary.total);

      await mainSceneProbe.skipRewardOpening(page);
      const lastSummary = await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'chained summary',
      });
      // Nothing else unlocked is unclaimed, so no chain is offered.
      expect(lastSummary.nextLabel).toBeNull();

      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, { label: 'overlay closed' });
    } finally {
      await context.close();
    }
  });

  it('drains achievement resumes before auto-resuming a revealed boss chest', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.seedPendingRewardResumeScenario(page);
      await mainSceneProbe.resumePendingRewardPresentations(page);

      const achievement = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'achievement reward presentation to open first',
      });
      expect(achievement.phase).toBe('anticipation');
      expect(achievement.total).toBe(2);

      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);

      const bossChest = await waitForRewardOpeningState(page, (s) => s.open && s.total === 1, {
        label: 'boss chest reward presentation to auto-resume second',
      });
      expect(bossChest.phase).toBe('anticipation');
      expect(bossChest.total).toBe(1);

      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, {
        label: 'all resumed reward presentations to finish',
      });
    } finally {
      await context.close();
    }
  });

  it('opens the reward overlay when the player walks into a live physical boss chest', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.resolveLoadout(page);
      await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
        label: 'paused playing state after loadout resolution',
      });
      await mainSceneProbe.setPlayerFeet(page, 10, 10);
      const chest = await mainSceneProbe.seedAvailableBossChest(page, 18, 10);
      expect(chest, 'probe should seed a physical boss chest entity').toEqual({ x: 18, y: 10 });

      await mainSceneProbe.advanceSimulationFrames(page, 1);
      expect(await mainSceneProbe.getRewardOpeningState(page)).toEqual({
        open: false,
        phase: null,
        bucket: null,
        revealed: 0,
        total: 0,
        nextLabel: null,
      });

      await mainSceneProbe.setPlayerFeet(page, 18, 10);
      await mainSceneProbe.advanceSimulationFrames(page, 1);
      const opened = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'live boss chest proximity reveal to open without manual resume',
      });
      expect(opened.phase).toBe('anticipation');
      expect(opened.total).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('does not leak queued E interactions after the reward overlay closes', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.resolveLoadout(page);
      await mainSceneProbe.setSimulationPaused(page, false);
      await waitForState(page, (s) => s.worldState === 'playing' && !s.simulationPaused, {
        label: 'playing state with live simulation',
      });
      const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
      expect(npcTarget, 'probe should expose an NPC interaction target').not.toBeNull();

      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'reward overlay to open' });

      await page.keyboard.press('e');
      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, {
        label: 'reward overlay to close after queued E input',
      });
      await page.waitForTimeout(250);

      const state = await mainSceneProbe.getState(page);
      expect(
        state.conversationOpen,
        'E pressed during the reward overlay must not fire after close',
      ).toBe(false);
    } finally {
      await context.close();
    }
  });
});

/**
 * Deterministic e2e coverage proving the reward-opening audio hooks are
 * REALLY wired into `MainGameScene` (not just the pure `reward-audio-cues.ts`
 * decision functions, already exhaustively unit-tested). Observes the ordered
 * `SynthCueSpec` log actually dispatched to the real `AudioCueEngine` via
 * `mainSceneProbe.getRewardAudioCueLog()` — see
 * `MainGameScene.rewardAudioCueLog` / `createRewardAudioCueLoggingEngine`.
 */
describe('real reward-opening audio cues (achievement path)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('dispatches cues in anticipation → reveal → summary → close order with no reveal cues on immediate skip', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'overlay to open' });

      let log = await mainSceneProbe.getRewardAudioCueLog(page);
      expect(log.map((entry) => entry.label)).toEqual(['reward:anticipation']);

      // Skip straight from anticipation: the sequence jumps directly to
      // 'summary' (never through 'revealing'), but the skip path
      // architecturally suppresses the phase-change hook for that
      // transition (`RewardOpeningUI.handleSkip()` calls
      // `render({ suppressPhaseChangeHook: true })`), so 'reward:summary'
      // is NEVER logged for a skip — it is not merely inaudible, it is
      // never even scheduled (adversarial plan review finding: relying on
      // same-JS-tick `AudioContext.currentTime` cancellation timing was
      // correct but fragile/non-obvious). 'reward:skip' fires instead, as
      // the sole audible "skip acknowledged" whoosh. No
      // 'reward:item-revealed'/'reward:rarity-escalation' cues should ever have fired,
      // proving the audio hooks track the REAL reveal loop, not a fixed
      // per-item cue independent of it.
      await mainSceneProbe.skipRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => s.phase === 'summary', {
        label: 'skip to land on summary',
      });
      log = await mainSceneProbe.getRewardAudioCueLog(page);
      expect(log.map((entry) => entry.label)).toEqual(['reward:anticipation', 'reward:skip']);
      expect(log.some((entry) => entry.label === 'reward:item-revealed')).toBe(false);
      expect(log.some((entry) => entry.label === 'reward:rarity-escalation')).toBe(false);
      expect(log.some((entry) => entry.label === 'reward:summary')).toBe(false);

      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, { label: 'overlay to close' });
      log = await mainSceneProbe.getRewardAudioCueLog(page);
      expect(log.map((entry) => entry.label)).toEqual([
        'reward:anticipation',
        'reward:skip',
        'reward:close',
      ]);
    } finally {
      await context.close();
    }
  });

  it('dispatches one reveal cue per item, in forward reveal order, when never skipped', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      const anticipation = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'overlay to open',
      });
      expect(anticipation.total).toBe(2);

      await advanceRewardOpeningToSummary(page, anticipation.total);

      const log = await mainSceneProbe.getRewardAudioCueLog(page);
      const labels = log.map((entry) => entry.label);
      // Exactly one reveal cue per item, all BEFORE the summary cue, with
      // anticipation strictly first.
      expect(labels[0]).toBe('reward:anticipation');
      expect(labels.filter((label) => label === 'reward:item-revealed')).toHaveLength(
        anticipation.total,
      );
      expect(labels.at(-1)).toBe('reward:summary');
      expect(labels.indexOf('reward:summary')).toBeGreaterThan(
        labels.lastIndexOf('reward:item-revealed'),
      );
    } finally {
      await context.close();
    }
  });

  it('scales reveal-cue intensity (gain) with box tier, matching the visual excitement bucket', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      const trash = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'trash-tier overlay to open',
      });
      expect(trash.bucket).toBe('modest');
      await advanceRewardOpeningToSummary(page, trash.total);
      const trashLog = await mainSceneProbe.getRewardAudioCueLog(page);
      const trashRevealGain = Math.max(
        ...trashLog.filter((e) => e.label === 'reward:item-revealed').map((e) => e.gain),
      );
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, { label: 'trash overlay to close' });
      await mainSceneProbe.clearRewardAudioCueLog(page);

      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      const rare = await waitForRewardOpeningState(page, (s) => s.open, {
        label: 'rare-tier overlay to open',
      });
      expect(rare.bucket).toBe('exciting');
      await advanceRewardOpeningToSummary(page, rare.total);
      const rareLog = await mainSceneProbe.getRewardAudioCueLog(page);
      const rareRevealGain = Math.max(
        ...rareLog.filter((e) => e.label === 'reward:item-revealed').map((e) => e.gain),
      );

      // Same axis the visual bucket already proves (rare 'exciting' >
      // trash 'modest') must show up in the synthesized reveal-cue gain too —
      // excitement scales audio and visuals consistently from the same
      // underlying tier score.
      expect(rareRevealGain).toBeGreaterThan(trashRevealGain);
    } finally {
      await context.close();
    }
  });

  it('scales anticipation-cue duration/gain down under reduced motion, never to zero', async () => {
    const { context: normalContext, page: normalPage } = await newPage(browser);
    const reducedContext = await browser.newContext({ reducedMotion: 'reduce' });
    const reducedPage = await reducedContext.newPage();
    try {
      await loadMainSceneProbeLab(reducedPage);

      await mainSceneProbe.claimAchievementReward(normalPage, RARE_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(normalPage, (s) => s.open, { label: 'normal overlay open' });
      const normalLog = await mainSceneProbe.getRewardAudioCueLog(normalPage);
      const normalAnticipation = normalLog.find((e) => e.label === 'reward:anticipation');
      expect(normalAnticipation).toBeDefined();

      await mainSceneProbe.claimAchievementReward(reducedPage, RARE_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(reducedPage, (s) => s.open, {
        label: 'reduced-motion overlay open',
      });
      const reducedLog = await mainSceneProbe.getRewardAudioCueLog(reducedPage);
      const reducedAnticipation = reducedLog.find((e) => e.label === 'reward:anticipation');
      expect(reducedAnticipation).toBeDefined();

      expect(reducedAnticipation!.durationMs).toBeLessThan(normalAnticipation!.durationMs);
      expect(reducedAnticipation!.gain).toBeLessThan(normalAnticipation!.gain);
      // Reduced-intensity mixing quiets/shortens cues, it never silences them.
      expect(reducedAnticipation!.durationMs).toBeGreaterThan(0);
      expect(reducedAnticipation!.gain).toBeGreaterThan(0);
    } finally {
      await normalContext.close();
      await reducedContext.close();
    }
  });

  it('does not leak cues across a closed session into the next reward presentation', async () => {
    const { context, page } = await newPage(browser);
    try {
      await mainSceneProbe.claimAchievementReward(page, TRASH_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'first overlay open' });
      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, { label: 'first overlay closed' });

      const firstLog = await mainSceneProbe.getRewardAudioCueLog(page);
      expect(firstLog.map((e) => e.label)).toEqual([
        'reward:anticipation',
        'reward:skip',
        'reward:close',
      ]);

      // A fresh open() defensively calls stopAll() but does NOT clear the
      // log itself (the log is a pure observation surface, not part of
      // playback) — the probe clears it explicitly between scenarios so a
      // second, real reward presentation starts from a clean, unambiguous
      // anticipation cue with nothing bleeding over from the first.
      await mainSceneProbe.clearRewardAudioCueLog(page);
      await mainSceneProbe.claimAchievementReward(page, RARE_TIER_ACHIEVEMENT_ID);
      await waitForRewardOpeningState(page, (s) => s.open, { label: 'second overlay open' });
      const secondLog = await mainSceneProbe.getRewardAudioCueLog(page);
      expect(secondLog.map((e) => e.label)).toEqual(['reward:anticipation']);

      await mainSceneProbe.skipRewardOpening(page);
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await waitForRewardOpeningState(page, (s) => !s.open, { label: 'second overlay closed' });
      // Duplicate acknowledge/skip after close must never replay a close/skip
      // cue — the real hooks only fire on an ACTUAL phase/visibility change.
      const afterDuplicateLen = (await mainSceneProbe.getRewardAudioCueLog(page)).length;
      await mainSceneProbe.acknowledgeRewardOpening(page);
      await mainSceneProbe.skipRewardOpening(page);
      const stillSameLen = (await mainSceneProbe.getRewardAudioCueLog(page)).length;
      expect(stillSameLen).toBe(afterDuplicateLen);
    } finally {
      await context.close();
    }
  });
});
