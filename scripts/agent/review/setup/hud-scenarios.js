// Tracked A|B HUD scenarios for visual review.
(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__hudProbe;
  if (!probe?.ready?.()) throw new Error('__hudProbe not ready');
  probe.setScenario('safe-room-unlocked');
  window.__visualReview = {
    surface: 'in-game HUD',
    regions: [],
    expect: {},
  };
  window.__visualReviewHoverPoint = null;
  await new Promise((resolve) => setTimeout(resolve, 250));
})();
