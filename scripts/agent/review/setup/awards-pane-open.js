(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__mainSceneProbe;
  if (!probe?.ready?.()) throw new Error('__mainSceneProbe not ready');
  probe.resolveLoadout();
  probe.setSafeContext(true);

  for (const id of [
    'first-bonk',
    'room-sweeper',
    'ten-chain',
    'ratings-climbing',
    'floor2-field-kit',
    'floor2-run-two-floor-gauntlet',
    'floor2-run-fully-outfitted',
  ]) {
    probe.unlockAchievement(id);
  }
  await new Promise((resolve) => setTimeout(resolve, 3200));
  probe.openAchievements();
  for (let attempt = 0; attempt < 40 && !probe.getState().achievementsOpen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!probe.getState().achievementsOpen) throw new Error('Awards pane did not open');

  // Claim through the real Awards button path, then acknowledge the shared
  // presentation so the pane can be judged with a visibly opened chest row.
  probe.claimAchievementReward('room-sweeper');
  for (let attempt = 0; attempt < 50 && !probe.getRewardOpeningState().open; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!probe.getRewardOpeningState().open) throw new Error('reward-opening overlay did not open');
  probe.skipRewardOpening();
  probe.acknowledgeRewardOpening();
  for (let attempt = 0; attempt < 40 && !probe.getState().achievementsOpen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!probe.getState().achievementsOpen)
    throw new Error('Awards pane closed after reward acknowledgement');

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const designRegions = probe.getAchievementsLayoutRegions();
  if (!designRegions.length) throw new Error('Awards pane published no layout regions');
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('no canvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const toScreen = (box) => ({
    x: rect.left + box.x * dpr * scaleX,
    y: rect.top + box.y * dpr * scaleY,
    width: box.width * dpr * scaleX,
    height: box.height * dpr * scaleY,
  });
  const regions = designRegions.map((region) => ({
    id: region.id,
    box: toScreen(region.box),
    kind: region.kind,
    ...(region.parentId ? { parentId: region.parentId } : {}),
  }));
  const panel = regions.find((region) => region.id === 'awards-panel');
  if (!panel) throw new Error('awards-panel region missing');

  window.__visualReview = {
    surface: 'Awards pane with opened reward',
    regions,
    expect: {},
  };
  const margin = 16;
  const clipX = Math.max(0, panel.box.x - margin);
  const clipY = Math.max(0, panel.box.y - margin);
  window.__visualReviewClip = {
    x: clipX,
    y: clipY,
    width: Math.min(window.innerWidth - clipX, panel.box.width + margin * 2),
    height: Math.min(window.innerHeight - clipY, panel.box.height + margin * 2),
  };
  window.__visualReviewHoverPoint = null;
})();
