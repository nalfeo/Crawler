(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__abilitiesProbe;
  if (!probe?.ready?.()) throw new Error('__abilitiesProbe not ready');
  const canvasHost = document.querySelector('#lab-canvas');
  const controls = document.querySelector('#lab-controls');
  const header = document.querySelector('#app-header');
  const controlsToggle = document.querySelector('#controls-toggle');
  const debugHotbar = document.querySelector('#abilities-debug-hotbar');
  const debugHud = document.querySelector('#abilities-debug-hud');
  if (header instanceof HTMLElement) header.style.display = 'none';
  if (controlsToggle instanceof HTMLElement) controlsToggle.style.display = 'none';
  if (controls instanceof HTMLElement) controls.style.display = 'none';
  if (debugHotbar instanceof HTMLElement) debugHotbar.style.display = 'none';
  if (debugHud instanceof HTMLElement) debugHud.style.display = 'none';
  if (canvasHost instanceof HTMLElement) {
    canvasHost.style.width = '100vw';
    canvasHost.style.height = '100vh';
    if (canvasHost.parentElement) {
      canvasHost.parentElement.style.width = '100vw';
      canvasHost.parentElement.style.height = '100vh';
    }
  }
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
  const authoredScale = snapshot.listViewport.width / 716;
  const rowRegions = snapshot.visibleRowLayouts.flatMap((layout) => {
    const rowId = `ability-row:${layout.id}`;
    return [
      {
        id: rowId,
        box: toScreenshotBox(layout.row),
        kind: 'row',
        parentId: 'ability-list',
      },
      {
        id: `${rowId}.tile`,
        box: toScreenshotBox({
          x: layout.row.x + 12 * authoredScale,
          y: layout.row.y + 20 * authoredScale,
          width: 62 * authoredScale,
          height: 62 * authoredScale,
        }),
        kind: 'tile',
        parentId: rowId,
      },
      {
        id: `${rowId}.details`,
        box: toScreenshotBox(layout.details),
        kind: 'text',
        parentId: rowId,
      },
      {
        id: `${rowId}.description`,
        box: toScreenshotBox(layout.description),
        kind: 'text',
        parentId: rowId,
      },
      {
        id: `${rowId}.action`,
        box: toScreenshotBox({
          x: layout.row.x + layout.row.width - 124 * authoredScale,
          y: layout.row.y + 32 * authoredScale,
          width: 112 * authoredScale,
          height: 38 * authoredScale,
        }),
        kind: 'action',
        parentId: rowId,
      },
    ];
  });

  window.__visualReview = {
    surface: 'abilities loadout default state',
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
      ...rowRegions,
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
