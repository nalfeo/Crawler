// Tracked A|B HUD dungeon scenario for visual review.
(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__hudProbe;
  if (!probe?.ready?.()) throw new Error('__hudProbe not ready');
  probe.setScenario('dungeon');
  window.__visualReview = {
    surface: 'in-game HUD',
    regions: [],
    expect: {},
  };
  window.__visualReviewHoverPoint = null;

  // Hide the lab chrome (header + control panel) so the capture shows only
  // the real in-game HUD, matching the equipment probe's approach.
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controls = document.getElementById('lab-controls');
  if (controls) controls.style.display = 'none';
  const host = document.getElementById('lab-canvas');
  if (host) {
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.zIndex = '9999';
    host.style.background = '#000';
  }
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 500));
})();
