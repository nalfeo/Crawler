;(async () => {
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
  probe?.equipCharm?.();
  // Equip a handful straight from the integrated bag so the paper-doll looks
  // lived-in while leaving plenty of gear in the bag column to review.
  const seededBag = probe?.getEquipmentBagItemIds?.() ?? [];
  for (const id of seededBag.slice(0, 5)) {
    probe?.equipFromEquipmentBag?.(id);
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

  // Force one re-layout, then let it settle BEFORE we set the inspector preview
  // at the end. applyLayout() nulls the panel's render signature, so the next
  // per-frame refresh() re-renders the panel; we must let that render happen
  // first or it would wipe the preview we set below.
  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => setTimeout(r, 400));

  const slotIds = [
    'head',
    'face',
    'neck',
    'shoulders',
    'chest',
    'back',
    'leftArm',
    'rightArm',
    'leftWrist',
    'rightWrist',
    'mainHand',
    'offHand',
    'gloves',
    'ringLeft',
    'ringRight',
    'belt',
    'legs',
    'feet',
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
    // The equip-delta inspector preview is set deterministically at the very
    // end (below), after layout has settled — see the comment there.
  }
  // Deterministically show the equip-delta inspector — the headline new
  // feature. Set this LAST so nothing re-renders the panel afterward: refresh()
  // only re-renders on a signature change and none happen now, so the preview
  // persists through the capture wait. A direct probe call is reliable where the
  // synthesized pointer hover was flaky. Prefer the SECOND remaining bag item:
  // the first is a duplicate of the equipped neck charm (→ "NO STAT CHANGE"),
  // whereas a different item shows real green/red stat deltas.
  const remaining = probe?.getEquipmentBagItemIds?.() ?? [];
  const previewId = remaining[1] ?? remaining[0];
  if (previewId) {
    probe?.previewEquipmentBagItem?.(previewId);
  }
  // Keep the focused panel clip (do NOT null it) and prevent the runner from
  // moving the mouse — a stray pointerout would clear the preview we just set.
  window.__visualReviewHoverPoint = null;
})();
