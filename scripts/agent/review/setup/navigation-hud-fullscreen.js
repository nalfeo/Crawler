(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__navigationHudProbe;
  const mobile = new URLSearchParams(location.search).get('mobile') === '1';
  const floor = Number(new URLSearchParams(location.search).get('floor') ?? '1');
  probe?.setStressState?.(floor);

  document.getElementById('app-header')?.remove();
  document.getElementById('lab-controls')?.remove();
  const host = document.getElementById('lab-canvas');
  if (host) {
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.width = mobile ? '844px' : '1280px';
    host.style.height = mobile ? '390px' : '720px';
    host.style.zIndex = '9999';
    host.style.background = '#05060f';
  }
  document.body.style.margin = '0';
  document.body.style.background = '#05060f';
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM' }));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const canvas = document.querySelector('#lab-canvas canvas');
  const rect = canvas?.getBoundingClientRect();
  const toScreenshot = (box) =>
    rect
      ? {
          x: rect.x + box.x * (rect.width / 1280),
          y: rect.y + box.y * (rect.height / 720),
          width: box.width * (rect.width / 1280),
          height: box.height * (rect.height / 720),
        }
      : box;
  const bounds = probe?.getBounds?.();
  const regions = [];
  if (bounds?.mapOverlay)
    regions.push({
      id: 'map-overlay',
      box: toScreenshot(bounds.mapOverlay),
      kind: 'panel',
    });
  if (bounds?.mapClose)
    regions.push({
      id: 'map-close',
      box: toScreenshot(bounds.mapClose),
      kind: 'control',
      parentId: 'map-overlay',
    });
  const flags = [];
  if (
    bounds?.radar ||
    bounds?.questTracker ||
    bounds?.familyPanel ||
    (bounds?.arrows.length ?? 0) > 0
  ) {
    flags.push('Docked navigation chrome remains visible over the fullscreen map.');
  }
  window.__visualReview = {
    surface: `navigation HUD fullscreen floor ${floor}${mobile ? ' mobile' : ''}`,
    regions,
    expect: {},
    flags,
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
