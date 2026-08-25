// Deterministic equipment tooltip scenarios for release UX baselines.
(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__uiProbe;
  const scenario = new URLSearchParams(window.location.search).get('uxScenario');

  await probe?.useRealGeneratedSprites?.();
  probe?.seedAllGear?.();
  probe?.openEquipmentOnly?.();

  if (scenario === 'equipment-hover-equipped') {
    probe?.equipInventoryItem?.('iron-helm');
    // Drive the same public preview seam used by the real slot hover handler.
    // Forcing a raw slot id bypassed the equipped-item lookup and produced an
    // empty-slot screenshot rather than a truthful hover state.
    probe?.selectEquipmentSlot?.('head');
  } else if (scenario === 'equipment-hover-duplicate') {
    probe?.equipInventoryItem?.('iron-helm');
    probe?.seedAllGear?.();
    await new Promise((resolve) => setTimeout(resolve, 350));
    probe?.previewEquipmentBagItem?.('iron-helm');
  } else if (scenario === 'equipment-hover-empty-slot') {
    probe?.selectEquipmentSlot?.('feet');
  } else if (scenario === 'equipment-hover-mixed-delta') {
    probe?.equipInventoryItem?.('iron-breastplate');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const candidateKey = probe?.addGeneratedChestReplacement?.();
    if (!candidateKey) throw new Error('Unable to seed the generated chest replacement.');
    probe?.previewGeneratedEquipmentBagItem?.(candidateKey);
  } else {
    throw new Error(`Unknown equipment UX scenario: ${scenario ?? '<missing>'}`);
  }

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
  if (scenario === 'equipment-hover-equipped') {
    // Resize causes EquipmentUI to rebuild its pooled slot objects, which clears
    // transient hover content. Invoke the real preview seam only after that final
    // layout pass so this capture represents an actual equipped-item hover.
    probe?.previewEquipmentSlot?.('head');
  } else if (scenario === 'equipment-hover-empty-slot') {
    // Recreate the actual bag-item hover after the final resize while retaining
    // Feet's active outline as the preview target.
    probe?.previewEquipmentBagItem?.('leather-boots');
  }
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
  const panel = probe?.getEquipmentPanelBounds?.();
  const regions = slotIds
    .map((slotId) => {
      const box = probe?.getEquipmentSlotBounds?.(slotId);
      return box ? { id: `slot:${slotId}`, box, kind: 'slot', parentId: 'equipment-panel' } : null;
    })
    .filter(Boolean);
  for (const slotId of slotIds) {
    const box = probe?.getEquipmentSlotBounds?.(slotId);
    const icon = probe?.getEquipmentSlotIconBounds?.(slotId);
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
  if (panel) regions.unshift({ id: 'equipment-panel', box: panel, kind: 'panel' });
  const tooltip = probe?.getEquipmentTooltipBounds?.();
  const hoveredSlotId =
    scenario === 'equipment-hover-equipped'
      ? 'head'
      : scenario === 'equipment-hover-empty-slot'
        ? 'feet'
        : null;
  const hoveredSlot = hoveredSlotId ? probe?.getEquipmentSlotBounds?.(hoveredSlotId) : null;
  const hoveredBagIndex =
    scenario === 'equipment-hover-empty-slot'
      ? probe?.getEquipmentBagItemIds?.().findLastIndex((itemId) => itemId === 'leather-boots')
      : -1;
  const hoveredBag =
    hoveredBagIndex !== undefined && hoveredBagIndex >= 0
      ? probe?.getEquipmentBagCellBounds?.(hoveredBagIndex)
      : null;
  const hoverTarget = hoveredBag ?? hoveredSlot;
  const hoverTargetId = hoveredBag
    ? 'hover-target:bag:leather-boots'
    : hoveredSlotId
      ? `hover-target:${hoveredSlotId}`
      : null;
  if (hoverTarget && hoverTargetId) {
    // The hover target and tooltip share a parent so the deterministic reviewer
    // hard-fails any overlap instead of leaving occlusion to the LLM.
    regions.push({
      id: hoverTargetId,
      box: hoverTarget,
      kind: 'slot',
      parentId: 'hover-context',
    });
  }
  if (tooltip)
    regions.push({ id: 'tooltip', box: tooltip, kind: 'tooltip', parentId: 'hover-context' });
  if (scenario === 'equipment-hover-empty-slot' && hoverTarget && tooltip) {
    const padding = 16;
    const left = Math.max(0, Math.min(hoverTarget.x, tooltip.x) - padding);
    const top = Math.max(0, Math.min(hoverTarget.y, tooltip.y) - padding);
    const right = Math.max(hoverTarget.x + hoverTarget.width, tooltip.x + tooltip.width) + padding;
    const bottom =
      Math.max(hoverTarget.y + hoverTarget.height, tooltip.y + tooltip.height) + padding;
    // Hover reviews inspect this interaction at readable scale. The full panel
    // remains in declared geometry for placement context, while Azure receives
    // the target-and-card crop as the detailed inspection frame.
    window.__visualReviewClip = { x: left, y: top, width: right - left, height: bottom - top };
  }
  const doll = probe?.getEquipmentDollBounds?.();
  if (doll) regions.push({ id: 'paper-doll', box: doll, kind: 'panel' });
  const stats = probe?.getEquipmentStatsBounds?.();
  if (stats) regions.push({ id: 'stats-panel', box: stats, kind: 'panel' });
  const bag = probe?.getEquipmentBagColumnBounds?.();
  if (bag) regions.push({ id: 'bag-panel', box: bag, kind: 'panel' });
  const headerIds = new Map([
    ['Equipment', 'header:equipment'],
    ['Stats', 'header:stats'],
    ['Bag', 'header:bag'],
  ]);
  for (const run of probe?.getEquipmentTextRuns?.() ?? []) {
    const id = headerIds.get(run.text);
    if (id) regions.push({ id, box: run.bounds, kind: 'header' });
  }
  const flags = [];
  if (hoveredSlotId && !probe?.isEquipmentTooltipTopmost?.()) {
    flags.push('Tooltip is behind another equipment-panel element.');
  }
  window.__visualReview = {
    surface: 'equipment panel',
    regions,
    expect: { tooltipAfterHover: true },
    flags,
  };
  window.__visualReviewHoverPoint = null;
})();
