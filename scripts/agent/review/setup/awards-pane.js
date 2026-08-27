(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__mainSceneProbe;
  if (!probe?.ready?.()) throw new Error('__mainSceneProbe not ready');
  probe.resolveLoadout();
  probe.setSafeContext(true);
  for (const id of ['first-bonk', 'room-sweeper', 'crafting-initiate', 'resource-rat']) {
    probe.unlockAchievement(id);
  }
  probe.openAchievements();
  for (let attempt = 0; attempt < 40 && !probe.getState().achievementsOpen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!probe.getState().achievementsOpen) throw new Error('Awards pane did not open');
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  window.__visualReview = {
    surface: 'Awards pane',
    regions: [],
    expect: {},
  };
  window.__visualReviewHoverPoint = null;
})();
