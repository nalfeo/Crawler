(async () => {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const probe = window.__mobMotionProbe;
  if (!probe) {
    throw new Error('Mob Motion Lab probe is unavailable.');
  }

  const waitForReady = async (timeoutMs = 10_000) => {
    const deadline = performance.now() + timeoutMs;
    while (!probe.ready() && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!probe.ready()) {
      throw new Error('Mob Motion Lab did not become ready.');
    }
  };

  await waitForReady();

  probe.selectEnemy('goblin-junkshot');
  probe.setTime(250);
  await waitForReady();

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
    host.style.background = '#080b12';
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const canvas = host?.querySelector('canvas');
  if (!canvas) {
    throw new Error('Mob Motion Lab canvas is unavailable.');
  }
  const rect = canvas.getBoundingClientRect();
  const contentX = rect.x + canvas.clientLeft;
  const contentY = rect.y + canvas.clientTop;
  const scaleX = canvas.clientWidth / 960;
  const scaleY = canvas.clientHeight / 660;
  const panelTitles = ['spawn', 'movement', 'attack', 'hit', 'death', 'status'];
  const regions = [
    {
      id: 'motion-grid',
      box: {
        x: contentX,
        y: contentY,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      },
      kind: 'panel',
    },
    ...panelTitles.map((title, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      return {
        id: `motion:${title}`,
        box: {
          x: contentX + (20 + column * 312) * scaleX,
          y: contentY + (18 + row * 324) * scaleY,
          width: 296 * scaleX,
          height: 304 * scaleY,
        },
        kind: 'panel',
        parentId: 'motion-grid',
      };
    }),
  ];

  window.__visualReview = {
    surface: 'mob motion effect grid',
    regions,
    expect: {},
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
