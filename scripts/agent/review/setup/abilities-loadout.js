(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__abilitiesProbe;
  if (!probe?.ready?.()) throw new Error('__abilitiesProbe not ready');
  probe.openLoadout();
  for (let attempt = 0; attempt < 50 && !probe.getSnapshot().open; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const snapshot = probe.getSnapshot();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (!snapshot.panel || !snapshot.listViewport || !snapshot.footer || !canvas) {
    throw new Error('abilities loadout bounds unavailable');
  }
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / 1280;
  const scaleY = rect.height / 720;
  const toScreenshotBox = (box) => ({
    x: box.x * scaleX,
    y: box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  });

  window.__visualReview = {
    surface: 'abilities loadout',
    regions: [
      { id: 'loadout-panel', box: toScreenshotBox(snapshot.panel), kind: 'panel' },
      {
        id: 'ability-list',
        box: toScreenshotBox(snapshot.listViewport),
        kind: 'section',
        parentId: 'loadout-panel',
      },
      {
        id: 'loadout-footer',
        box: toScreenshotBox(snapshot.footer),
        kind: 'section',
        parentId: 'loadout-panel',
      },
      ...snapshot.visibleRows.map((box, index) => ({
        id: `ability-row:${index + 1}`,
        box: toScreenshotBox(box),
        kind: 'row',
        parentId: 'ability-list',
      })),
    ],
    expect: {},
  };
  window.__visualReviewClip = {
    x: Math.floor(rect.left),
    y: Math.floor(rect.top),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };
  window.__visualReviewHoverPoint = null;
})();
