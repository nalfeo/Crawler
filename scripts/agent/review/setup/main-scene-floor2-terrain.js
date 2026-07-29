(async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = window.__mainSceneProbe?.getTerrainRenderSummary?.();
    if ((summary?.packFloorCount ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controls = document.getElementById('lab-controls');
  if (controls) controls.style.display = 'none';
  const host = document.getElementById('lab-canvas');
  if (host) {
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.zIndex = '9999';
    host.style.background = '#000';
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const canvas = document.querySelector('#lab-canvas canvas');
  const rect = canvas?.getBoundingClientRect();
  window.__visualReview = {
    surface: 'Floor 2 terrain in MainGameScene',
    regions: rect
      ? [
          {
            id: 'main-game-canvas',
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            kind: 'other',
          },
        ]
      : [],
    expect: {},
    flags: rect ? [] : ['MainGameScene canvas was unavailable after boot.'],
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
