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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const snapshot = probe.getSnapshot();
    if (snapshot.visibleSectionHeaderLabel === 'PASSIVE ABILITIES') break;
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'ArrowDown',
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  for (let step = 0; step < 3; step += 1) {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'ArrowDown',
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const snapshot = probe.getSnapshot();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (!snapshot.panel || !snapshot.listViewport || !snapshot.footer || !canvas) {
    throw new Error('passive abilities loadout bounds unavailable');
  }
  if (snapshot.visibleSectionHeaderLabel !== 'PASSIVE ABILITIES') {
    throw new Error('passive section heading did not remain visible after scrolling');
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
    const rowId = `passive-row:${layout.id}`;
    return [
      {
        id: rowId,
        box: toScreenshotBox(layout.row),
        kind: 'row',
        parentId: 'passive-list',
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
        id: `${rowId}.state`,
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
    surface: 'abilities loadout passive state',
    regions: [
      { id: 'passive-panel', box: toScreenshotBox(snapshot.panel), kind: 'panel' },
      {
        id: 'passive-list',
        box: toScreenshotBox(snapshot.listViewport),
        kind: 'section',
        parentId: 'passive-panel',
      },
      {
        id: 'passive-footer',
        box: toScreenshotBox(snapshot.footer),
        kind: 'section',
        parentId: 'passive-panel',
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
