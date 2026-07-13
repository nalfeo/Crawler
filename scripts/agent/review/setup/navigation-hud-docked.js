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
  await new Promise((resolve) => setTimeout(resolve, 700));

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
  if (bounds?.radar)
    regions.push({
      id: 'radar',
      box: toScreenshot(bounds.radar),
      kind: 'panel',
      parentId: 'navigation',
    });
  if (bounds?.questTracker)
    regions.push({
      id: 'quest-tracker',
      box: toScreenshot(bounds.questTracker),
      kind: 'panel',
      parentId: 'navigation',
    });
  if (bounds?.familyPanel)
    regions.push({
      id: 'family-panel',
      box: toScreenshot(bounds.familyPanel),
      kind: 'panel',
      parentId: 'navigation',
    });
  for (const [index, box] of (bounds?.arrows ?? []).entries()) {
    regions.push({
      id: `direction-arrow:${index}`,
      box: toScreenshot(box),
      kind: 'indicator',
      parentId: 'navigation',
    });
  }
  window.__visualReview = {
    surface: `navigation HUD docked floor ${floor}${mobile ? ' mobile' : ''}`,
    regions,
    expect: {},
    flags: [],
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
