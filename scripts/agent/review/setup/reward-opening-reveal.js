(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__mainSceneProbe;
  if (!probe?.ready?.()) throw new Error('__mainSceneProbe not ready');
  const canvasHost = document.querySelector('#lab-canvas');
  const controls = document.querySelector('#lab-controls');
  const header = document.querySelector('#app-header');
  const controlsToggle = document.querySelector('#controls-toggle');
  if (header instanceof HTMLElement) header.style.display = 'none';
  if (controlsToggle instanceof HTMLElement) controlsToggle.style.display = 'none';
  if (controls instanceof HTMLElement) controls.style.display = 'none';
  if (canvasHost instanceof HTMLElement) {
    canvasHost.style.width = '100vw';
    canvasHost.style.height = '100vh';
    if (canvasHost.parentElement) {
      canvasHost.parentElement.style.width = '100vw';
      canvasHost.parentElement.style.height = '100vh';
    }
  }

  probe.resolveLoadout();
  probe.setSimulationPaused(false);
  // room-sweeper is the 'rare' tier achievement — highest-intensity real
  // content path reachable through the achievement route (see the E2E spec's
  // scoping docstring for why boss-chest rarity variation isn't reachable).
  probe.claimAchievementReward('room-sweeper');

  for (let attempt = 0; attempt < 50 && !probe.getRewardOpeningState().open; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Advance past the anticipation phase into the reveal phase so the
  // screenshot captures the actual reward-card presentation, not just the
  // pre-reveal anticipation beat.
  for (
    let attempt = 0;
    attempt < 60 && probe.getRewardOpeningState().phase === 'anticipation';
    attempt += 1
  ) {
    probe.tickRewardOpening(50);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  // Let a little reveal animation play out so cards are visible/settled.
  for (let i = 0; i < 10; i += 1) {
    probe.tickRewardOpening(50);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = probe.getRewardOpeningState();
  if (!state.open) throw new Error('reward-opening overlay did not open');

  // No pixel-precise layout probe exists yet for RewardOpeningUI (unlike the
  // boss reward picker's getModalPickerLayout()) — this is a screenshot-only,
  // non-gating pass per the visual-review skill's documented fallback path.
  window.__visualReview = {
    surface: `reward-opening overlay (phase=${state.phase}, bucket=${state.bucket})`,
    regions: [],
    expect: {},
  };
  window.__visualReviewHoverPoint = null;
})();
