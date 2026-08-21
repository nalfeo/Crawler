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
    window.__forceEquipmentTooltipSlot = 'head';
  } else if (scenario === 'equipment-hover-duplicate') {
    probe?.equipInventoryItem?.('iron-helm');
    probe?.seedAllGear?.();
    await new Promise((resolve) => setTimeout(resolve, 350));
    probe?.previewEquipmentBagItem?.('iron-helm');
  } else if (scenario === 'equipment-hover-empty-slot') {
    await new Promise((resolve) => setTimeout(resolve, 350));
    probe?.previewEquipmentBagItem?.('leather-boots');
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
  if (panel) regions.unshift({ id: 'equipment-panel', box: panel, kind: 'panel' });
  const tooltip = probe?.getEquipmentTooltipBounds?.();
  if (tooltip) regions.push({ id: 'tooltip', box: tooltip, kind: 'tooltip' });
  window.__visualReview = {
    surface: 'equipment panel',
    regions,
    expect: { tooltipAfterHover: true },
  };
  window.__visualReviewHoverPoint = null;
})();
