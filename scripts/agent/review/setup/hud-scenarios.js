// Tracked A|B HUD scenarios for visual review.
(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__hudProbe;
  if (!probe?.ready?.()) throw new Error('__hudProbe not ready');
  probe.setScenario('safe-room-unlocked');
  probe.setInfoTextVisible?.(false);
  const regions = probe.getVisualReviewRegions?.() ?? {};
  // Classify each region into a real kind/parentId so the generic
  // sibling-overlap, container-overrun, and touch-with-no-breathing-room
  // deterministic checks actually run against the HUD (a flat "panel" kind
  // for every region is excluded from all of those checks).
  const PANEL_IDS = new Set([
    'abilitiesPanel',
    'hud-health-panel-bounds',
    'hud-skill-panel-bounds',
    'timerPanel',
    'bossPanel',
    'minimap',
    'hud-loot-gold-value-bounds',
    'hud-loot-junk-value-bounds',
  ]);
  const PARENT_OF = {
    'hud-loot-gold-value-bounds': 'hud-health-panel-bounds',
    'hud-loot-gold-text': 'hud-loot-gold-value-bounds',
    'hud-loot-junk-value-bounds': 'hud-health-panel-bounds',
    'hud-loot-junk-text': 'hud-loot-junk-value-bounds',
    'hud-skill-title-strip': 'hud-skill-panel-bounds',
    'hud-skill-title-text': 'hud-skill-title-strip',
    'hud-skill-class-name-text': 'hud-skill-panel-bounds',
    'hud-skill-class-level': 'hud-skill-panel-bounds',
    'hud-skill-class-bar-bg': 'hud-skill-panel-bounds',
    'hud-skill-type-name-text': 'hud-skill-panel-bounds',
    'hud-skill-type-level': 'hud-skill-panel-bounds',
    'hud-skill-type-bar-bg': 'hud-skill-panel-bounds',
    timerText: 'timerPanel',
    bossText: 'bossPanel',
  };
  const TEXT_IDS = new Set([
    'hud-loot-gold-text',
    'hud-loot-junk-text',
    'hud-skill-title-text',
    'hud-skill-class-name-text',
    'hud-skill-class-level',
    'hud-skill-type-name-text',
    'hud-skill-type-level',
    'timerText',
    'bossText',
  ]);
  const classified = Object.entries(regions).map(([id, box]) => {
    let kind = 'other';
    if (PANEL_IDS.has(id)) kind = 'panel';
    else if (TEXT_IDS.has(id)) kind = 'text';
    const parentId = PARENT_OF[id];
    return parentId ? { id, box, kind, parentId } : { id, box, kind };
  });
  window.__visualReview = {
    surface: 'in-game HUD (safe room)',
    regions: classified,
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
