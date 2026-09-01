// Tracked A|B scenarios for the Floor-2 Family Relationships HUD panel.
(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  let probe = window.__familyRelProbe;
  for (let attempt = 0; attempt < 60 && !probe?.ready?.(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    probe = window.__familyRelProbe;
  }
  if (!probe?.ready?.()) throw new Error('__familyRelProbe not ready');

  const scenario =
    new URLSearchParams(window.location.search).get('uxScenario') ??
    'family-relationships-band-spectrum';
  if (scenario === 'family-relationships-band-spectrum') {
    probe.setStressState('representative');
    probe.setBossDefeated(1, true);
  } else if (scenario === 'family-relationships-boss-aftermath') {
    probe.setStressState('representative');
    for (let index = 0; index < 4; index += 1) probe.setBossDefeated(index, true);
  } else if (scenario === 'family-relationships-compact-stress') {
    probe.setStressState('worst-case');
  } else {
    throw new Error(`Unknown Family Relationships UX scenario: ${scenario}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Hide lab chrome and let the canvas resize BEFORE measuring geometry, so
  // the region/clip boxes are computed against final on-screen layout.
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controls = document.getElementById('lab-controls');
  if (controls) controls.style.display = 'none';
  const controlsToggle = document.getElementById('controls-toggle');
  if (controlsToggle) controlsToggle.style.display = 'none';
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const layout = probe.getLayout();
  const panel = layout.family.panel;
  if (!panel) throw new Error('family panel did not render');
  const defeatedCount = layout.family.rows.filter((row) => row.bossDefeated).length;
  const expectedDefeated =
    scenario === 'family-relationships-band-spectrum'
      ? 1
      : scenario === 'family-relationships-boss-aftermath'
        ? 4
        : 2;
  if (defeatedCount !== expectedDefeated) {
    throw new Error(
      `${scenario} expected ${expectedDefeated} defeated bosses, got ${defeatedCount}`,
    );
  }
  if (layout.family.rows.some((row) => row.displayedName.includes('…'))) {
    throw new Error(`${scenario} must render every real family identity without truncation`);
  }
  if (layout.family.rows.some((row) => row.bossStateLabel !== (row.bossDefeated ? 'OUT' : 'UP'))) {
    throw new Error(`${scenario} boss state labels must read UP or OUT`);
  }
  if (layout.family.rows.some((row) => row.relationTicks.length !== 3)) {
    throw new Error(`${scenario} must expose the 25/50/75 standing thresholds`);
  }

  // Canvas (design space, GAME_W x GAME_H) -> CSS pixel space for the capture.
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('no canvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  const toScreen = (box) => ({
    x: rect.left + box.x * scaleX,
    y: rect.top + box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  });

  const regions = [{ id: 'family-panel', box: toScreen(panel), kind: 'panel' }];
  if (layout.family.title) {
    regions.push({
      id: 'family-title',
      box: toScreen(layout.family.title),
      kind: 'text',
      parentId: 'family-panel',
    });
  }
  if (layout.family.columnHeader && layout.family.columnLabels) {
    regions.push({
      id: 'family-column-header',
      box: toScreen(layout.family.columnHeader),
      kind: 'content',
      parentId: 'family-panel',
    });
    for (const [id, box] of Object.entries(layout.family.columnLabels)) {
      regions.push({
        id: `family-column-${id}`,
        box: toScreen(box),
        kind: 'text',
        parentId: 'family-column-header',
      });
    }
  }
  layout.family.rows.forEach((row, index) => {
    const rowId = `family-row-${index}`;
    regions.push({ id: rowId, box: toScreen(row.row), kind: 'content', parentId: 'family-panel' });
    regions.push({
      id: `${rowId}-swatch`,
      box: toScreen(row.swatch),
      kind: 'icon',
      parentId: rowId,
    });
    regions.push({ id: `${rowId}-name`, box: toScreen(row.name), kind: 'text', parentId: rowId });
    regions.push({ id: `${rowId}-bar`, box: toScreen(row.bar), kind: 'control', parentId: rowId });
    row.relationTicks.forEach((tick, tickIndex) => {
      regions.push({
        id: `${rowId}-threshold-${tickIndex}`,
        box: toScreen(tick),
        kind: 'content',
        parentId: `${rowId}-bar`,
      });
    });
    regions.push({ id: `${rowId}-value`, box: toScreen(row.value), kind: 'text', parentId: rowId });
    regions.push({
      id: `${rowId}-boss-tile`,
      box: toScreen(row.bossTile),
      kind: 'content',
      parentId: rowId,
    });
    regions.push({
      id: `${rowId}-boss-label`,
      box: toScreen(row.bossLabel),
      kind: 'text',
      parentId: `${rowId}-boss-tile`,
    });
    regions.push({
      id: `${rowId}-status-pill`,
      box: toScreen(row.statusPill),
      kind: 'content',
      parentId: rowId,
    });
    regions.push({
      id: `${rowId}-status`,
      box: toScreen(row.status),
      kind: 'text',
      parentId: `${rowId}-status-pill`,
    });
  });

  window.__visualReview = {
    surface: `Family Relationships (HUD panel, ${scenario})`,
    regions,
    expect: {},
  };

  // Zoom the judge onto the panel + a small margin so attention stays on the
  // surface under review rather than the surrounding lab/dungeon backdrop.
  const margin = 24;
  const panelBox = regions[0].box;
  const clipX = Math.max(0, panelBox.x - margin);
  const clipY = Math.max(0, panelBox.y - margin);
  window.__visualReviewClip = {
    x: clipX,
    y: clipY,
    width: Math.min(window.innerWidth - clipX, panelBox.width + margin * 2),
    height: Math.min(window.innerHeight - clipY, panelBox.height + margin * 2),
  };
  window.__visualReviewHoverPoint = null;
})();
