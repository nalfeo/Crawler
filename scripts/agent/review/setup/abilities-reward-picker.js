(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__mainSceneProbe;
  if (!probe?.ready?.()) throw new Error('__mainSceneProbe not ready');
  const canvasHost = document.querySelector('#lab-canvas');
  const controls = document.querySelector('#lab-controls');
  const header = document.querySelector('#app-header');
  const controlsToggle = document.querySelector('#controls-toggle');
  if (header instanceof HTMLElement) header.style.display = 'none';
  if (controlsToggle instanceof HTMLElement) controlsToggle.style.display = 'none';
  if (controls instanceof HTMLElement) controls.style.display = 'none';
  if (canvasHost instanceof HTMLElement) {
    canvasHost.style.width = '100vw';
    canvasHost.style.height = '100vh';
    if (canvasHost.parentElement) {
      canvasHost.parentElement.style.width = '100vw';
      canvasHost.parentElement.style.height = '100vh';
    }
  }
  probe.openBossRewardPicker();
  for (let attempt = 0; attempt < 50 && !probe.getModalPickerLayout(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const snapshot = probe.getModalPickerLayout();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (!snapshot || !canvas) throw new Error('boss reward picker layout unavailable');
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / 1280;
  const scaleY = rect.height / 720;
  const toScreenshotBox = (box) => ({
    x: rect.left + box.x * scaleX,
    y: rect.top + box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  });

  window.__visualReview = {
    surface: 'real Floor-1 boss reward ability picker',
    regions: [
      { id: 'reward-panel', box: toScreenshotBox(snapshot.panel), kind: 'panel' },
      {
        id: 'reward-title',
        box: toScreenshotBox(snapshot.title),
        kind: 'text',
        parentId: 'reward-panel',
      },
      ...(snapshot.subtitle
        ? [
            {
              id: 'reward-subtitle',
              box: toScreenshotBox(snapshot.subtitle),
              kind: 'text',
              parentId: 'reward-panel',
            },
          ]
        : []),
      ...(snapshot.body
        ? [
            {
              id: 'reward-body',
              box: toScreenshotBox(snapshot.body),
              kind: 'text',
              parentId: 'reward-panel',
            },
          ]
        : []),
      ...snapshot.rows.flatMap((entry, index) => [
        {
          id: `reward-row:${index + 1}`,
          box: toScreenshotBox(entry.row),
          kind: 'row',
          parentId: 'reward-panel',
        },
        {
          id: `reward-row:${index + 1}.label`,
          box: toScreenshotBox(entry.label),
          kind: 'text',
          parentId: `reward-row:${index + 1}`,
        },
        {
          id: `reward-row:${index + 1}.description`,
          box: toScreenshotBox(entry.description),
          kind: 'text',
          parentId: `reward-row:${index + 1}`,
        },
      ]),
      {
        id: 'reward-footer',
        box: toScreenshotBox(snapshot.footer),
        kind: 'text',
        parentId: 'reward-panel',
      },
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
