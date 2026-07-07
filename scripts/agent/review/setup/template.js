(() => {
  // 1) Open/drive the target UX state.
  // Example:
  // window.__uiProbe?.openInventory?.();
  // window.__uiProbe?.openEquipment?.();

  // 2) Hide lab chrome for clean capture.
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controls = document.getElementById('lab-controls');
  if (controls) controls.style.display = 'none';

  // 3) Expand canvas host to viewport.
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
})();
