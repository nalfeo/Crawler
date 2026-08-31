(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__mainSceneProbe;
  if (!probe?.ready?.()) throw new Error('__mainSceneProbe not ready');

  const scenario = new URLSearchParams(location.search).get('awardsScenario') ?? 'all';
  probe.resolveLoadout();
  probe.setSafeContext(true);
  const ids =
    scenario === 'empty-filter'
      ? ['first-bonk']
      : scenario === 'long-flavor'
        ? ['ratings-climbing']
        : ['first-bonk', 'room-sweeper', 'ten-chain', 'ratings-climbing', 'floor2-field-kit'];
  for (const id of ids) probe.unlockAchievement(id);
  await new Promise((resolve) => setTimeout(resolve, 3200));
  probe.openAchievements();
  for (let attempt = 0; attempt < 40 && !probe.getState().achievementsOpen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!probe.getState().achievementsOpen) throw new Error('Awards pane did not open');

  if (scenario === 'empty-filter' || scenario === 'filter-working') {
    // Empty results selects Global (the fixture has only floor-scoped rows).
    // The working-filter fixture selects Floor 1 from the same live chip row.
    probe.setAchievementsFilter(scenario === 'empty-filter' ? 'global' : 'floor:1');
    await new Promise((resolve) => setTimeout(resolve, 150));
  } else if (scenario === 'long-flavor') {
    probe.setAchievementExpanded('ratings-climbing', true);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const canvas = document.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas');
  const designRegions = probe.getAchievementsLayoutRegions();
  if (!designRegions.length) throw new Error('Awards pane published no layout regions');
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
    surface: `Awards pane (${scenario})`,
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
