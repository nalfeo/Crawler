/**
 * Helpers for the `main-scene-probe-lab`-driven e2e characterization suite.
 *
 * MainGameScene (the ~2331-LOC engine god-class) is Phaser-coupled, so its boot
 * wiring and camera-follow behavior can only be observed by booting the real
 * scene in a browser. The lab (`src/labs/main-scene-probe-lab/index.ts`) boots
 * it through the shipped floor bootstrap with a fixed seed and exposes a typed
 * `window.__mainSceneProbe` API; these helpers load the lab, wait for the probe
 * to report `ready()`, and provide typed wrappers the spec drives.
 */
import type { Page } from 'playwright';
import { E2E_LAB_BASE_URL } from '../e2e-constants.js';
// Type-only import (erased at runtime — does NOT execute the lab's registerLab).
import type {
  BloodSurfaceProbeSummary,
  BossIntroProbeState,
  CarriedWeaponRenderInfo,
  HarvestableRenderSummary,
  PropRenderSize,
  FamilyHudProbeState,
  FloatingTextProbe,
  ItemIconRenderInfo,
  MainSceneProbeApi,
  MainSceneState,
  NpcRenderInfo,
  ProbePoint,
  RewardAudioCueLogEntryProbe,
  RewardOpeningProbeState,
  SafeAreaLayoutProbe,
  TerrainRenderSummary,
  DoorRenderSummary,
  StaircaseMarkerRenderInfo,
} from '../../../src/labs/main-scene-probe-lab/index.js';
import type { GeneratedEquipmentInstanceKey } from '../../../src/shared/generated-equipment-types.js';
import type { UsageMetric } from '../../../src/shared/skills.js';
import type { ScreenBounds } from '../../../src/engine/ui-scale.js';

declare global {
  interface Window {
    __mainSceneProbe?: MainSceneProbeApi;
  }
}

const LAB_ID = 'main-scene-probe-lab';

/** Navigate to the probe lab and wait for `window.__mainSceneProbe.ready()`. */
export async function loadMainSceneProbeLab(
  page: Page,
  params: Record<string, string | number> = {},
  baseUrl = E2E_LAB_BASE_URL,
): Promise<void> {
  const query = new URLSearchParams({ lab: LAB_ID });
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const url = `${baseUrl}/lab.html?${query.toString()}`;
  // `commit` (not `networkidle`/`load`): Vite keeps a persistent HMR socket open
  // and may trigger a one-off optimize-deps page reload on the first load of a
  // lab, so waiting on network state is flaky. We commit the navigation and poll
  // for the probe's ready flag instead, re-navigating within a bounded number of
  // windows if an optimize/reload cycle wedges a single polling window.
  await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
  const windows = 3;
  for (let i = 0; i < windows; i += 1) {
    try {
      await page.waitForFunction(() => Boolean(window.__mainSceneProbe?.ready()), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      // A few frames of headroom so the first boot sync()/render pass settles.
      await page.waitForTimeout(600);
      return;
    } catch (err) {
      if (i === windows - 1) throw err;
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    }
  }
}

/** Typed wrappers around the in-page `window.__mainSceneProbe` automation API. */
export const mainSceneProbe = {
  getState: (page: Page): Promise<MainSceneState> =>
    page.evaluate(() => window.__mainSceneProbe!.getState()),
  setSafeContext: (page: Page, enabled: boolean): Promise<void> =>
    page.evaluate((value) => window.__mainSceneProbe!.setSafeContext(value), enabled),
  unlockSafeRoomSurfaces: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.unlockSafeRoomSurfaces()),
  setEquipmentPanelUnlocked: (page: Page, unlocked: boolean): Promise<void> =>
    page.evaluate((value) => window.__mainSceneProbe!.setEquipmentPanelUnlocked(value), unlocked),
  resolveLoadout: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.resolveLoadout()),
  activateFamilyRelationships: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.activateFamilyRelationships()),
  getFamilyHudState: (page: Page): Promise<FamilyHudProbeState> =>
    page.evaluate(() => window.__mainSceneProbe!.getFamilyHudState()),
  openBossRewardPicker: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.openBossRewardPicker()),
  startStaircaseBossBattle: (page: Page): Promise<number> =>
    page.evaluate(() => window.__mainSceneProbe!.startStaircaseBossBattle()),
  primeFloor1StairTransition: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.primeFloor1StairTransition()),
  getBossIntroState: (page: Page): Promise<BossIntroProbeState> =>
    page.evaluate(() => window.__mainSceneProbe!.getBossIntroState()),
  scrollBossIntro: (page: Page, delta: number): Promise<void> =>
    page.evaluate((lines) => window.__mainSceneProbe!.scrollBossIntro(lines), delta),
  dismissBossIntro: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.dismissBossIntro()),
  getModalPickerLayout: (page: Page) =>
    page.evaluate(() => window.__mainSceneProbe!.getModalPickerLayout()),
  getModalPickerContent: (page: Page) =>
    page.evaluate(() => window.__mainSceneProbe!.getModalPickerContent()),
  primeShopkeeperPurchase: (page: Page, gold: number): Promise<ProbePoint | null> =>
    page.evaluate((value) => window.__mainSceneProbe!.primeShopkeeperPurchase(value), gold),
  primeShopkeeperPostQuestStock: (
    page: Page,
    gold: number,
    ownFirstOffer = false,
  ): Promise<{
    readonly position: ProbePoint;
    readonly firstItemId: string | null;
    readonly stockCount: number;
  } | null> =>
    page.evaluate(
      ({ value, own }) => window.__mainSceneProbe!.primeShopkeeperPostQuestStock(value, own),
      { value: gold, own: ownFirstOffer },
    ),
  primeSpellBrokerStock: (
    page: Page,
    gold: number,
    learnFirstOffer = false,
  ): Promise<{
    readonly position: ProbePoint;
    readonly firstSpellId: string | null;
    readonly offerCount: number;
  } | null> =>
    page.evaluate(
      ({ value, learn }) => window.__mainSceneProbe!.primeSpellBrokerStock(value, learn),
      { value: gold, learn: learnFirstOffer },
    ),
  getSafeAreaLayout: (page: Page): Promise<SafeAreaLayoutProbe> =>
    page.evaluate(() => window.__mainSceneProbe!.getSafeAreaLayout()),
  setSimulationPaused: (page: Page, paused: boolean): Promise<void> =>
    page.evaluate((p) => window.__mainSceneProbe!.setSimulationPaused(p), paused),
  advanceSimulationFrames: (page: Page, frames: number): Promise<void> =>
    page.evaluate((count) => window.__mainSceneProbe!.advanceSimulationFrames(count), frames),
  setPlayerFeet: (page: Page, x: number, y: number): Promise<void> =>
    page.evaluate(({ x: fx, y: fy }) => window.__mainSceneProbe!.setPlayerFeet(fx, fy), { x, y }),
  seedBloodPool: (page: Page, x: number, y: number, color: number): Promise<number | null> =>
    page.evaluate(
      ({ x: fx, y: fy, color: tint }) => window.__mainSceneProbe!.seedBloodPool(fx, fy, tint),
      { x, y, color },
    ),
  getBloodSurfaceSummary: (page: Page): Promise<BloodSurfaceProbeSummary> =>
    page.evaluate(() => window.__mainSceneProbe!.getBloodSurfaceSummary()),
  primeNpcInteractionTarget: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.primeNpcInteractionTarget()),
  primeQuestWaypointArrows: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.primeQuestWaypointArrows()),
  primeCrowdedDownRightQuestWaypointArrows: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.primeCrowdedDownRightQuestWaypointArrows()),
  getVisibleQuestArrowIds: (page: Page): Promise<string[]> =>
    page.evaluate(() => window.__mainSceneProbe!.getVisibleQuestArrowIds()),
  getVisibleQuestArrowStates: (page: Page) =>
    page.evaluate(() => window.__mainSceneProbe!.getVisibleQuestArrowStates()),
  requestAchievementsToggle: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.requestAchievementsToggle()),
  requestQuartermasterToggle: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.requestQuartermasterToggle()),
  requestInventoryToggle: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.requestInventoryToggle()),
  requestEquipToggle: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.requestEquipToggle()),
  queueAbilitiesToggle: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.queueAbilitiesToggle()),
  queueSkillUsage: (
    page: Page,
    skillId: string,
    metric: UsageMetric,
    amount: number,
  ): Promise<void> =>
    page.evaluate(
      ({ id, usageMetric, usageAmount }) =>
        window.__mainSceneProbe!.queueSkillUsage(id, usageMetric, usageAmount),
      { id: skillId, usageMetric: metric, usageAmount: amount },
    ),
  equipPlayerActiveAbility: (page: Page, abilityId: string): Promise<boolean> =>
    page.evaluate((id) => window.__mainSceneProbe!.equipPlayerActiveAbility(id), abilityId),
  primeMagicMissileLightProbe: (page: Page): Promise<boolean> =>
    page.evaluate(() => window.__mainSceneProbe!.primeMagicMissileLightProbe()),
  getMagicMissileLightProbe: (page: Page) =>
    page.evaluate(() => window.__mainSceneProbe!.getMagicMissileLightProbe()),
  getAbilityFloaters: (
    page: Page,
  ): Promise<
    ReadonlyArray<{
      readonly abilityId: string;
      readonly label: string;
      readonly x: number;
      readonly y: number;
      readonly visible: boolean;
      readonly alpha: number;
    }>
  > => page.evaluate(() => window.__mainSceneProbe!.getAbilityFloaters()),
  setWorldState: (page: Page, state: MainSceneState['worldState']): Promise<void> =>
    page.evaluate(
      (value) =>
        window.__mainSceneProbe!.setWorldState(
          value as 'playing' | 'loadout' | 'safe_room' | 'level_up' | 'game_over',
        ),
      state,
    ),
  tapAbilitiesButton: (page: Page): Promise<boolean> =>
    page.evaluate(() => window.__mainSceneProbe!.tapAbilitiesButton()),
  tapQuartermasterButton: (page: Page): Promise<boolean> =>
    page.evaluate(() => window.__mainSceneProbe!.tapQuartermasterButton()),
  queueAbilitiesAndAchievementsToggle: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.queueAbilitiesAndAchievementsToggle()),
  queueInteraction: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.queueInteraction()),
  getCameraCenter: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getCameraCenter()),
  getMapSizeFeet: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getMapSizeFeet()),
  getCameraViewSize: (page: Page): Promise<ProbePoint | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getCameraViewSize()),
  getNpcRenderInfo: (page: Page): Promise<NpcRenderInfo[]> =>
    page.evaluate(() => window.__mainSceneProbe!.getNpcRenderInfo()),
  getHarvestableRenderSummary: (page: Page): Promise<HarvestableRenderSummary> =>
    page.evaluate(() => window.__mainSceneProbe!.getHarvestableRenderSummary()),
  getPropRenderSizes: (page: Page): Promise<PropRenderSize[]> =>
    page.evaluate(() => window.__mainSceneProbe!.getPropRenderSizes()),
  equipMainHandWeapon: (page: Page, weaponId: string): Promise<boolean> =>
    page.evaluate((id) => window.__mainSceneProbe!.equipMainHandWeapon(id), weaponId),
  getCarriedWeaponRenderInfo: (page: Page): Promise<CarriedWeaponRenderInfo> =>
    page.evaluate(() => window.__mainSceneProbe!.getCarriedWeaponRenderInfo()),
  getTerrainRenderSummary: (page: Page): Promise<TerrainRenderSummary> =>
    page.evaluate(() => window.__mainSceneProbe!.getTerrainRenderSummary()),
  getDoorRenderSummary: (page: Page): Promise<DoorRenderSummary> =>
    page.evaluate(() => window.__mainSceneProbe!.getDoorRenderSummary()),
  getStaircaseMarkerRenderInfo: (page: Page): Promise<StaircaseMarkerRenderInfo> =>
    page.evaluate(() => window.__mainSceneProbe!.getStaircaseMarkerRenderInfo()),
  claimAchievementReward: (
    page: Page,
    achievementId: string,
  ): Promise<readonly GeneratedEquipmentInstanceKey[]> =>
    page.evaluate((id) => window.__mainSceneProbe!.claimAchievementReward(id), achievementId),
  seedPendingRewardResumeScenario: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.seedPendingRewardResumeScenario()),
  seedAvailableBossChest: (page: Page, x?: number, y?: number): Promise<ProbePoint | null> =>
    page.evaluate(({ x: fx, y: fy }) => window.__mainSceneProbe!.seedAvailableBossChest(fx, fy), {
      x,
      y,
    }),
  resumePendingRewardPresentations: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.resumePendingRewardPresentations()),
  getRewardOpeningState: (page: Page): Promise<RewardOpeningProbeState> =>
    page.evaluate(() => window.__mainSceneProbe!.getRewardOpeningState()),
  advanceRewardOpeningRenderFrames: (
    page: Page,
    frames: number,
    deltaMs = 16,
  ): Promise<RewardOpeningProbeState> =>
    page.evaluate(
      ({ frameCount, frameDeltaMs }) =>
        window.__mainSceneProbe!.advanceRewardOpeningRenderFrames(frameCount, frameDeltaMs),
      { frameCount: frames, frameDeltaMs: deltaMs },
    ),
  sampleAutoDrivenRewardOpeningRenderFrames: (
    page: Page,
    firstFrames: number,
    nextFrames: number,
    deltaMs = 16,
  ): Promise<{
    readonly first: RewardOpeningProbeState;
    readonly next: RewardOpeningProbeState;
  }> =>
    page.evaluate(
      ({ firstFrameCount, nextFrameCount, frameDeltaMs }) =>
        window.__mainSceneProbe!.sampleAutoDrivenRewardOpeningRenderFrames(
          firstFrameCount,
          nextFrameCount,
          frameDeltaMs,
        ),
      {
        firstFrameCount: firstFrames,
        nextFrameCount: nextFrames,
        frameDeltaMs: deltaMs,
      },
    ),
  isRewardOpeningAutoDrivenForProbe: (page: Page): Promise<boolean> =>
    page.evaluate(() => window.__mainSceneProbe!.isRewardOpeningAutoDrivenForProbe()),
  tickRewardOpening: (page: Page, deltaMs: number): Promise<void> =>
    page.evaluate((ms) => window.__mainSceneProbe!.tickRewardOpening(ms), deltaMs),
  skipRewardOpening: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.skipRewardOpening()),
  acknowledgeRewardOpening: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.acknowledgeRewardOpening()),
  unlockAchievement: (page: Page, achievementId: string): Promise<void> =>
    page.evaluate((id) => window.__mainSceneProbe!.unlockAchievement(id), achievementId),
  getWorldElapsedMs: (page: Page): Promise<number | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getWorldElapsedMs()),
  getPlayerGold: (page: Page): Promise<number | null> =>
    page.evaluate(() => window.__mainSceneProbe!.getPlayerGold()),
  setPlayerGold: (page: Page, amount: number): Promise<void> =>
    page.evaluate((v) => window.__mainSceneProbe!.setPlayerGold(v), amount),
  getQuartermasterStockSnapshot: (
    page: Page,
  ): Promise<
    ReadonlyArray<{
      stockId?: string;
      offerId: string;
      quantity: number;
      unitPrice: number;
      displayName: string | null;
    }>
  > => page.evaluate(() => window.__mainSceneProbe!.getQuartermasterStockSnapshot()),
  getSettlementShopInventorySnapshot: (
    page: Page,
    npcEid: number,
  ): Promise<
    ReadonlyArray<{
      itemId: string;
      quantity: number;
      unitPrice: number;
      displayName: string | null;
    }>
  > =>
    page.evaluate(
      (eid) => window.__mainSceneProbe!.getSettlementShopInventorySnapshot(eid),
      npcEid,
    ),
  purchaseFirstQuartermasterOffer: (
    page: Page,
  ): Promise<{
    ok: boolean;
    reason?: string;
    goldSpent?: number;
    itemId?: string;
    instanceId?: GeneratedEquipmentInstanceKey;
  }> => page.evaluate(() => window.__mainSceneProbe!.purchaseFirstQuartermasterOffer()),
  getInventoryVisibleItemIds: (page: Page): Promise<readonly string[]> =>
    page.evaluate(() => window.__mainSceneProbe!.getInventoryVisibleItemIds()),
  openFirstAvailableBossChest: (page: Page): Promise<{ ok: boolean; reason?: string }> =>
    page.evaluate(() => window.__mainSceneProbe!.openFirstAvailableBossChest()),
  spawnAndPickupFloorDrop: (
    page: Page,
    itemId: string,
  ): Promise<{ ok: boolean; reason?: string }> =>
    page.evaluate((id) => window.__mainSceneProbe!.spawnAndPickupFloorDrop(id), itemId),
  getGeneratedInventoryCellBounds: (
    page: Page,
    instanceKey: GeneratedEquipmentInstanceKey,
  ): Promise<ScreenBounds | null> =>
    page.evaluate(
      (key) => window.__mainSceneProbe!.getGeneratedInventoryCellBounds(key),
      instanceKey,
    ),
  getGeneratedEquipmentBagCellBounds: (
    page: Page,
    instanceKey: GeneratedEquipmentInstanceKey,
  ): Promise<ScreenBounds | null> =>
    page.evaluate(
      (key) => window.__mainSceneProbe!.getGeneratedEquipmentBagCellBounds(key),
      instanceKey,
    ),
  getEquippedGeneratedInstanceKeys: (
    page: Page,
  ): Promise<readonly GeneratedEquipmentInstanceKey[]> =>
    page.evaluate(() => window.__mainSceneProbe!.getEquippedGeneratedInstanceKeys()),
  getItemIconRenderInfo: (page: Page, itemId: string): Promise<ItemIconRenderInfo> =>
    page.evaluate((id) => window.__mainSceneProbe!.getItemIconRenderInfo(id), itemId),
  getRewardAudioCueLog: (page: Page): Promise<readonly RewardAudioCueLogEntryProbe[]> =>
    page.evaluate(() => window.__mainSceneProbe!.getRewardAudioCueLog()),
  clearRewardAudioCueLog: (page: Page): Promise<void> =>
    page.evaluate(() => window.__mainSceneProbe!.clearRewardAudioCueLog()),
  getVisibleFloatingTexts: (page: Page, prefix = ''): Promise<readonly FloatingTextProbe[]> =>
    page.evaluate((value) => window.__mainSceneProbe!.getVisibleFloatingTexts(value), prefix),
};

/**
 * Poll the probe until `predicate(state)` holds (or throw on timeout). Used to
 * wait out the few frames Phaser needs to populate the display list / settle
 * the camera after a teleport, without any wall-clock coupling in assertions.
 */
export async function waitForState(
  page: Page,
  predicate: (state: MainSceneState) => boolean,
  options: { timeoutMs?: number; pollMs?: number; label?: string } = {},
): Promise<MainSceneState> {
  const { timeoutMs = 8_000, pollMs = 100, label = 'state predicate' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await mainSceneProbe.getState(page);
    if (predicate(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(pollMs);
  }
}

/**
 * Poll the reward-opening probe until `predicate(state)` holds (or throw on
 * timeout). Mirrors {@link waitForState} but for the shared reward-opening
 * overlay, whose phase transitions are driven by explicit `tick`/`skip` calls
 * rather than wall-clock time — this only exists to absorb the handful of
 * Phaser update-loop frames between issuing a probe call and its effect
 * landing, never to wait out a real presentation duration.
 */
export async function waitForRewardOpeningState(
  page: Page,
  predicate: (state: RewardOpeningProbeState) => boolean,
  options: { timeoutMs?: number; pollMs?: number; label?: string } = {},
): Promise<RewardOpeningProbeState> {
  const { timeoutMs = 8_000, pollMs = 50, label = 'reward-opening state predicate' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await mainSceneProbe.getRewardOpeningState(page);
    if (predicate(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(pollMs);
  }
}
export async function waitForCameraCenter(
  page: Page,
  expected: ProbePoint,
  tolerancePx: number,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ProbePoint> {
  const { timeoutMs = 8_000, pollMs = 80 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const center = await mainSceneProbe.getCameraCenter(page);
    if (
      center &&
      Math.abs(center.x - expected.x) <= tolerancePx &&
      Math.abs(center.y - expected.y) <= tolerancePx
    ) {
      return center;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for camera center ≈ (${expected.x}, ${expected.y}) ±${tolerancePx}px; ` +
          `last: ${JSON.stringify(center)}`,
      );
    }
    await page.waitForTimeout(pollMs);
  }
}
