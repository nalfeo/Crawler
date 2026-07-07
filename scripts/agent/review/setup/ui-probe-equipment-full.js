// Visual-review setup: fully-populated equipment paper-doll.
// Seeds every placeholder gear item, equips all of them through the real
// equip-from-bag path plus the merchant charm, opens the equipment-only view,
// and pins a tooltip on a filled slot so the judge sees a populated doll +
// populated tooltip together. Injected into the Playwright page context.
;(async () => {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const probe = window.__uiProbe;

  probe?.useThemedEquipmentReviewSprites?.();

  // Fill every slot: gear (15 slots) + merchant charm (neck).
  const gearIds = [
    'iron-helm',
    'iron-visor',
    'steel-pauldrons',
    'iron-breastplate',
    'travelers-cloak',
    'sturdy-belt',
    'iron-greaves',
    'leather-boots',
    'leather-gloves',
    'bronze-vambrace',
    'iron-armguard',
    'leather-bracer',
    'beaded-bracelet',
    'band-of-fortune',
    'signet-of-focus',
  ];
  probe?.seedAllGear?.();
  for (const id of gearIds) {
    probe?.equipInventoryItem?.(id);
  }
  probe?.equipCharm?.();

  // Show a populated tooltip on a filled slot.
  window.__forceEquipmentTooltipSlot = 'chest';
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

  window.__visualReviewClip = null;
  window.dispatchEvent(new Event('resize'));
})();
