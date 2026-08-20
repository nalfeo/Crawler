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
    probe?.equipCharm?.();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const duplicateId = probe?.getEquipmentBagItemIds?.()?.[0];
    if (duplicateId) probe?.previewEquipmentBagItem?.(duplicateId);
  } else if (scenario === 'equipment-hover-empty-slot') {
    probe?.equipInventoryItem?.('iron-helm');
    await new Promise((resolve) => setTimeout(resolve, 350));
    probe?.previewEquipmentBagItem?.('leather-boots');
  } else if (scenario === 'equipment-hover-mixed-delta') {
    probe?.equipInventoryItem?.('iron-helm');
    await new Promise((resolve) => setTimeout(resolve, 350));
    probe?.previewEquipmentBagItem?.('steel-pauldrons');
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
  window.__visualReviewHoverPoint = null;
})();
