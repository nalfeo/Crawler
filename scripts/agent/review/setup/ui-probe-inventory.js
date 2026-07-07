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

  // Declare a generic visual-review contract so the surface-agnostic UX judge
  // gets pixel-grounded regions for THIS surface instead of falling back to the
  // legacy equipment probe (which would emit equipment-only false blockers such
  // as the empty-slot tooltip). All bounds are design-space (1280x720), the same
  // space the probe reports. See .github/skills/visual-review/SKILL.md.
  {
    const cells = [];
    for (let i = 0; i < 512; i += 1) {
      const box = probe?.getInventoryCellBounds?.(i);
      if (!box) break;
      cells.push({ index: i, box });
    }
    const regions = cells.map((c) => ({
      id: `cell:${c.index}`,
      box: { x: c.box.x, y: c.box.y, width: c.box.width, height: c.box.height },
      kind: 'slot',
      parentId: 'inventory-panel',
    }));
    if (cells.length > 0) {
      // The probe exposes no inventory-panel bounds method, so synthesize the
      // panel as the union bounding box of every cell.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const c of cells) {
        minX = Math.min(minX, c.box.x);
        minY = Math.min(minY, c.box.y);
        maxX = Math.max(maxX, c.box.x + c.box.width);
        maxY = Math.max(maxY, c.box.y + c.box.height);
      }
      regions.unshift({
        id: 'inventory-panel',
        box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        kind: 'panel',
      });
    }
    // Inventory has no stat-label column, no empty-slot tooltip affordance, and
    // no PRIMARY/SECONDARY section dividers, so it opts into NONE of the three
    // conditional hard requirements — only the universal checks apply.
    window.__visualReview = {
      surface: 'inventory panel',
      regions,
      expect: {},
    };
    console.log(
      `[ui-probe-inventory] __visualReview declared: surface=inventory panel regions=${regions.length} (cells=${cells.length})`,
    );
  }

  // The inventory panel is centered on the black backdrop, so a full-frame
  // capture needs no clip and carries no crop risk.
  window.__visualReviewClip = null;
  // Keep the mouse still so no stray hover state leaks into the shot.
  window.__visualReviewHoverPoint = null;
})();
