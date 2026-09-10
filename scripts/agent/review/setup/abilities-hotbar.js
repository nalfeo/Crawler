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

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const snapshot = probe.getSnapshot();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (!snapshot.hotbar || !canvas) throw new Error('abilities hotbar bounds unavailable');
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
    surface: 'abilities hotbar (static equipped state; cooldown timers inactive)',
    regions: [
      { id: 'hotbar', box: toScreenshotBox(snapshot.hotbar), kind: 'panel' },
      ...snapshot.slots.flatMap((box, index) => {
        const slotId = `slot:${index + 1}`;
        return [
          {
            id: slotId,
            box: toScreenshotBox(box),
            kind: 'slot',
            parentId: 'hotbar',
          },
          {
            id: `${slotId}.key`,
            box: toScreenshotBox({
              x: box.x + 7,
              y: box.y + 6,
              width: 14,
              height: 19,
            }),
            kind: 'text',
            parentId: slotId,
          },
        ];
      }),
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
