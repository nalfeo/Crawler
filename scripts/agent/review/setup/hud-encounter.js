(async () => {
  const params = new URLSearchParams(window.location.search);
  const preset = params.get('preset') ?? 'simultaneous';
  const probe = window.__hudProbe;
  probe?.setEncounterPreset?.(preset);

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
    host.style.background = '#05070f';
  }
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 450));
  probe?.freezeAnimations?.();

  const bounds = probe?.getEncounterBounds?.();
  const regions = [];
  const add = (id, box, kind = 'panel', parentId) => {
    if (box) regions.push({ id, box, kind, ...(parentId ? { parentId } : {}) });
  };
  add('timer-panel', bounds?.timerPanel);
  add('timer-text', bounds?.timerText, 'text', 'timer-panel');
  add('boss-panel', bounds?.bossPanel);
  add('boss-text', bounds?.bossText, 'text', 'boss-panel');
  add('announcement-panel', bounds?.announcementPanel);
  add('announcement-text', bounds?.announcementText, 'text', 'announcement-panel');
  add('quest-panel', bounds?.questPanel);
  add('minimap', bounds?.minimap);
  window.__visualReview = {
    surface: `encounter HUD (${preset})`,
    regions,
    expect: {},
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
  console.log(`[hud-encounter] preset=${preset} regions=${regions.length}`);
})();
