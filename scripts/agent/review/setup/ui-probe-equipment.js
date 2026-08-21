(async () => {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const probe = window.__uiProbe;
  // Let the bag-cell hover (below) drive the inspector; don't force a slot tooltip.
  window.__forceEquipmentTooltipSlot = null;
  // Observe the REAL generated art (approved/placeholder icons via the shipped
  // boot preload path), not the synthetic themed probe icon.
  await probe?.useRealGeneratedSprites?.();
  probe?.openEquipmentOnly?.();

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

  // Force one re-layout, then let it settle BEFORE we set the inspector preview
  // at the end. applyLayout() nulls the panel's render signature, so the next
  // per-frame refresh() re-renders the panel; we must let that render happen
  // first or it would wipe the preview we set below.
  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => setTimeout(r, 400));

  const slotIds = [
    'head',
    'neck',
    'mainHand',
    'chest',
    'offHand',
    'gloves',
    'legs',
    'ring1',
    'feet',
    'ring2',
  ];
  const gameSize = probe?.getGameSize?.();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (probe && gameSize && canvas) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / gameSize.width;
    const scaleY = rect.height / gameSize.height;
    const panel = probe.getEquipmentPanelBounds?.();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const slotId of slotIds) {
      const b = probe.getEquipmentSlotBounds?.(slotId);
      if (!b) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    if (panel && panel.width > 0 && panel.height > 0) {
      const padX = 24;
      const padY = 24;
      window.__visualReviewClip = {
        x: Math.max(0, Math.floor(rect.left + panel.x * scaleX - padX)),
        y: Math.max(0, Math.floor(rect.top + panel.y * scaleY - padY)),
        width: Math.ceil(panel.width * scaleX + padX * 2),
        height: Math.ceil(panel.height * scaleY + padY * 2),
      };
    } else if (Number.isFinite(minX) && Number.isFinite(minY)) {
      const padX = 120;
      const padY = 70;
      window.__visualReviewClip = {
        x: Math.max(0, Math.floor(rect.left + minX * scaleX - padX)),
        y: Math.max(0, Math.floor(rect.top + minY * scaleY - padY)),
        width: Math.ceil((maxX - minX) * scaleX + padX * 2 + 320),
        height: Math.ceil((maxY - minY) * scaleY + padY * 2),
      };
    }
  }
  const regions = slotIds
    .map((slotId) => {
      const box = probe.getEquipmentSlotBounds?.(slotId);
      return box ? { id: `slot:${slotId}`, box, kind: 'slot', parentId: 'equipment-panel' } : null;
    })
    .filter(Boolean);
  for (const slotId of slotIds) {
    const box = probe.getEquipmentSlotBounds?.(slotId);
    const icon = probe.getEquipmentSlotIconBounds?.(slotId);
    if (!box || !icon) continue;
    const safeInset = 6;
    regions.push({
      id: `slot:${slotId}.safe`,
      box: {
        x: box.x + safeInset,
        y: box.y + safeInset,
        width: box.width - safeInset * 2,
        height: box.height - safeInset * 2,
      },
      kind: 'other',
      parentId: `slot:${slotId}`,
    });
    regions.push({
      id: `slot:${slotId}.icon`,
      box: icon,
      kind: 'icon',
      parentId: `slot:${slotId}.safe`,
    });
  }
  const equipmentPanel = probe.getEquipmentPanelBounds?.();
  if (equipmentPanel) {
    regions.unshift({ id: 'equipment-panel', box: equipmentPanel, kind: 'panel' });
  }
  const doll = probe.getEquipmentDollBounds?.();
  if (doll) regions.push({ id: 'paper-doll', box: doll, kind: 'panel' });
  const stats = probe.getEquipmentStatsBounds?.();
  if (stats) regions.push({ id: 'stats-panel', box: stats, kind: 'panel' });
  const bag = probe.getEquipmentBagColumnBounds?.();
  if (bag) regions.push({ id: 'bag-panel', box: bag, kind: 'panel' });
  const headerIds = new Map([
    ['Equipment', 'header:equipment'],
    ['Stats', 'header:stats'],
    ['Bag', 'header:bag'],
  ]);
  for (const run of probe.getEquipmentTextRuns?.() ?? []) {
    const id = headerIds.get(run.text);
    if (id) regions.push({ id, box: run.bounds, kind: 'header' });
  }
  window.__visualReview = {
    surface: 'equipment panel',
    regions,
    expect: {},
  };
  // The neutral Equipment scenario must show the panel exactly as opened, with
  // no forced slot or bag hover.
  window.__visualReviewHoverPoint = null;
})();
