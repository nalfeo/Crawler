(async () => {
  const TARGET = 'welcome-room-v2';
  const DEADLINE_MS = 45000;

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controlsEl = document.getElementById('lab-controls');
  const gui = controlsEl && controlsEl.__labGui;
  const pieceCtrl =
    gui &&
    (typeof gui.controllersRecursive === 'function'
      ? gui.controllersRecursive()
      : gui.controllers
    ).find((c) => c.property === 'setPieceId');

  if (controlsEl) controlsEl.style.display = 'none';

  const host = document.getElementById('lab-canvas');
  if (host) {
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.zIndex = '9999';
    host.style.background = '#000';

    const root = host.firstElementChild;
    if (root && root.lastElementChild) {
      root.lastElementChild.style.display = 'none';
    }
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => setTimeout(r, 250));

  const readyProbe = () => {
    const probe = window.__uiProbe;
    return !!probe && typeof probe.ready === 'function' && probe.ready() === true;
  };

  if (pieceCtrl && pieceCtrl.getValue() !== TARGET) {
    pieceCtrl.setValue(TARGET);
    await new Promise((r) => setTimeout(r, 250));
  }

  const allLoaded = () => {
    if (!readyProbe()) return false;
    const scene = window.__setPieceScene;
    const kids = (scene && scene.children && scene.children.list) || [];
    let realImages = 0;
    for (const o of kids) {
      if (o.type === 'Image') realImages += 1;
    }
    return realImages > 0;
  };

  const deadline = Date.now() + DEADLINE_MS;
  while (!allLoaded() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!allLoaded()) {
    throw new Error(`Set-piece scene did not finish loading within ${DEADLINE_MS}ms`);
  }

  await new Promise((r) => setTimeout(r, 1000));

  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
