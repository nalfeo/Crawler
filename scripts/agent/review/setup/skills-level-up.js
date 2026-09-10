(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__uiProbe;
  if (!probe?.ready?.()) throw new Error('__uiProbe not ready');
  const canvasHost = document.querySelector('#lab-canvas');
  const controls = document.querySelector('#lab-controls');
  const header = document.querySelector('#app-header');
  const controlsToggle = document.querySelector('#controls-toggle');
  if (header instanceof HTMLElement) header.style.display = 'none';
  if (controlsToggle instanceof HTMLElement) controlsToggle.style.display = 'none';
  if (controls instanceof HTMLElement) controls.style.display = 'none';
  if (canvasHost instanceof HTMLElement) {
    canvasHost.style.position = 'fixed';
    canvasHost.style.left = '0';
    canvasHost.style.top = '0';
    canvasHost.style.width = '100vw';
    canvasHost.style.height = '100vh';
    canvasHost.style.zIndex = '9999';
    canvasHost.style.background = '#000';
    if (canvasHost.parentElement) {
      canvasHost.parentElement.style.width = '100vw';
      canvasHost.parentElement.style.height = '100vh';
    }
    const gameCanvas = canvasHost.querySelector('canvas');
    if (gameCanvas instanceof HTMLCanvasElement) {
      gameCanvas.style.width = '100vw';
      gameCanvas.style.height = '100vh';
    }
  }
  probe.openLevelUp(5);
  for (let attempt = 0; attempt < 50 && !probe.isLevelUpOpen(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'ArrowDown',
      key: 'ArrowDown',
      bubbles: true,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const snapshot = probe.getLevelUpLayout();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (!snapshot || !canvas) throw new Error('level-up layout unavailable');
  if (snapshot.selectedStat !== 'dexterity') {
    throw new Error(`level-up review must select dexterity, got ${snapshot.selectedStat}`);
  }
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const rect = canvas.getBoundingClientRect();
  if (Math.abs(rect.width - 1280) > 1 || Math.abs(rect.height - 720) > 1) {
    throw new Error(`level-up canvas must capture at 1280x720, got ${rect.width}x${rect.height}`);
  }
  const gameSize = probe.getGameSize();
  const scaleX = rect.width / gameSize.width;
  const scaleY = rect.height / gameSize.height;
  const toScreenshotBox = (box) => ({
    x: rect.left + box.x * scaleX,
    y: rect.top + box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  });

  window.__visualReview = {
    surface: 'Skills journey level-up allocation',
    regions: [
      { id: 'level-up-panel', box: toScreenshotBox(snapshot.panel), kind: 'panel' },
      {
        id: 'level-up-header',
        box: toScreenshotBox(snapshot.header),
        kind: 'section',
        parentId: 'level-up-panel',
      },
      ...snapshot.rows.flatMap((entry) => {
        const rowId = `stat-row:${entry.stat}`;
        return [
          {
            id: rowId,
            box: toScreenshotBox(entry.row),
            kind: 'row',
            parentId: 'level-up-panel',
          },
          {
            id: `${rowId}.minus`,
            box: toScreenshotBox(entry.minus),
            kind: 'action',
            parentId: rowId,
          },
          {
            id: `${rowId}.plus`,
            box: toScreenshotBox(entry.plus),
            kind: 'action',
            parentId: rowId,
          },
        ];
      }),
      {
        id: 'level-up-footer',
        box: toScreenshotBox(snapshot.footer),
        kind: 'section',
        parentId: 'level-up-panel',
      },
      {
        id: 'level-up-footer.description',
        box: toScreenshotBox(snapshot.description),
        kind: 'text',
        parentId: 'level-up-footer',
      },
      {
        id: 'level-up-footer.hint',
        box: toScreenshotBox(snapshot.hint),
        kind: 'text',
        parentId: 'level-up-footer',
      },
      {
        id: 'level-up-footer.reset',
        box: toScreenshotBox(snapshot.reset),
        kind: 'action',
        parentId: 'level-up-footer',
      },
      {
        id: 'level-up-footer.confirm',
        box: toScreenshotBox(snapshot.confirm),
        kind: 'action',
        parentId: 'level-up-footer',
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
