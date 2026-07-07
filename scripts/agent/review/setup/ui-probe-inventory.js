(async () => {
  // Wait for the pixel font (Press Start 2P) so the ported typography renders
  // in its final face — this PR swapped the panel to that font, so a review
  // shot taken before font load would misjudge the typography.
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const probe = window.__uiProbe;
  // Observe the REAL generated art (approved/placeholder icons via the shipped
  // boot preload path), not the synthetic themed probe icon, so item cells look
  // like the shipped game.
  await probe?.useRealGeneratedSprites?.();
  probe?.openInventory?.();

  // Hide lab chrome for a clean capture.
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  const controls = document.getElementById('lab-controls');
  if (controls) controls.style.display = 'none';

  // Expand the canvas host to the viewport on a black backdrop.
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

  // Force one re-layout, then let it settle so the panel renders at final size
  // (applyLayout nulls the render signature; the next refresh re-renders it).
  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => setTimeout(r, 400));

  // The inventory panel is centered on the black backdrop, so a full-frame
  // capture needs no clip and carries no crop risk.
  window.__visualReviewClip = null;
  // Keep the mouse still so no stray hover state leaks into the shot.
  window.__visualReviewHoverPoint = null;
})();
