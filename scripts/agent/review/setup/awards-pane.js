(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__mainSceneProbe;
  if (!probe?.ready?.()) throw new Error('__mainSceneProbe not ready');
  probe.resolveLoadout();
  probe.setSafeContext(true);
  // Spread across scopes, floors, and rarity tiers so the filter chips and the
  // rarity-coded chests are all exercised in one capture.
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
  // Let the real scene drain its transient unlock toasts before capturing the
  // persistent Awards surface; otherwise the fixture obscures the first row.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  probe.openAchievements();
  for (let attempt = 0; attempt < 40 && !probe.getState().achievementsOpen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!probe.getState().achievementsOpen) throw new Error('Awards pane did not open');
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Measured geometry straight from the renderer, in design space. Using the
  // real boxes (rather than one hand-written panel rect) is what lets the
  // deterministic sensors catch chest-escapes-row and row-overflow defects.
  const designRegions = probe.getAchievementsLayoutRegions();
  if (!designRegions.length) throw new Error('Awards pane published no layout regions');

  // Design space -> CSS pixel space. The pane is drawn into the Phaser canvas,
  // so scale by the canvas' on-screen size and offset by its page position.
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
    surface: 'Awards pane',
    regions,
    expect: {},
  };

  // Zoom the judge onto JUST the panel (plus a small margin) so its attention
  // is spent on the pane rather than the surrounding dungeon and lab chrome.
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
