(async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (document.querySelectorAll('#lab-canvas canvas').length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const mapCellSizeInput = [...document.querySelectorAll('input')].find(
    (input) => input.value === '8',
  );
  if (mapCellSizeInput) {
    mapCellSizeInput.value = '16';
    mapCellSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
    mapCellSizeInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    host.style.background = '#080914';
    host.style.overflow = 'hidden';
  }

  const canvases = [...document.querySelectorAll('#lab-canvas canvas')];
  const mapCanvas = canvases.at(-1);
  for (const canvas of canvases.slice(0, -1)) canvas.style.display = 'none';
  if (mapCanvas) {
    mapCanvas.style.position = 'fixed';
    mapCanvas.style.left = '0';
    mapCanvas.style.top = '0';
    mapCanvas.style.width = '1280px';
    mapCanvas.style.height = '800px';
    mapCanvas.style.imageRendering = 'pixelated';
  }
  await new Promise((resolve) => setTimeout(resolve, 250));

  const rect = mapCanvas?.getBoundingClientRect();
  window.__visualReview = {
    surface: 'Floor 2 terrain map',
    regions: rect
      ? [
          {
            id: 'terrain-map',
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            kind: 'other',
          },
        ]
      : [],
    expect: {},
    flags: rect ? [] : ['Terrain map canvas was unavailable after boot.'],
  };
  window.__visualReviewClip = rect
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : null;
  window.__visualReviewHoverPoint = null;
})();
