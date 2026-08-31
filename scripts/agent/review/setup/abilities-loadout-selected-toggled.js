(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__abilitiesProbe;
  if (!probe?.ready?.()) throw new Error('__abilitiesProbe not ready');
  probe.openLoadout();
  for (let attempt = 0; attempt < 50 && !probe.getSnapshot().open; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const opened = probe.getSnapshot();
  const initialSelectedId = opened.selectedAbilityId;
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'ArrowDown',
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }),
  );
  for (
    let attempt = 0;
    attempt < 50 && probe.getSnapshot().selectedAbilityId === initialSelectedId;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const selected = probe.getSnapshot();
  const selectedId = selected.selectedAbilityId;
  const expectedSelectedId = opened.visibleAbilityIds[1];
  if (!expectedSelectedId || selectedId !== expectedSelectedId) {
    throw new Error('abilities loadout did not select the second row');
  }
  const initiallyEquipped = selected.equippedAbilityIds.includes(selectedId);
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      code: 'Enter',
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
  for (
    let attempt = 0;
    attempt < 50 &&
    probe.getSnapshot().equippedAbilityIds.includes(selectedId) === initiallyEquipped;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const snapshot = probe.getSnapshot();
  const canvas = document.querySelector('#lab-canvas canvas');
  if (!snapshot.panel || !snapshot.listViewport || !snapshot.footer || !canvas) {
    throw new Error('abilities loadout bounds unavailable');
  }
  if (snapshot.selectedAbilityId !== selectedId) {
    throw new Error('abilities loadout selection changed during toggle');
  }
  if (snapshot.equippedAbilityIds.includes(selectedId) === initiallyEquipped) {
    throw new Error('abilities loadout toggle did not change the selected row');
  }

  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / 1280;
  const scaleY = rect.height / 720;
  const toScreenshotBox = (box) => ({
    x: box.x * scaleX,
    y: box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  });
  const authoredScale = snapshot.listViewport.width / 716;
  const rowRegions = snapshot.visibleRowLayouts.flatMap((layout) => {
    const rowId = `ability-row:${layout.id}`;
    return [
      {
        id: rowId,
        box: toScreenshotBox(layout.row),
        kind: 'row',
        parentId: 'ability-list',
      },
      {
        id: `${rowId}.tile`,
        box: toScreenshotBox({
          x: layout.row.x + 12 * authoredScale,
          y: layout.row.y + 20 * authoredScale,
          width: 62 * authoredScale,
          height: 62 * authoredScale,
        }),
        kind: 'tile',
        parentId: rowId,
      },
      {
        id: `${rowId}.details`,
        box: toScreenshotBox(layout.details),
        kind: 'text',
        parentId: rowId,
      },
      {
        id: `${rowId}.description`,
        box: toScreenshotBox(layout.description),
        kind: 'text',
        parentId: rowId,
      },
      {
        id: `${rowId}.action`,
        box: toScreenshotBox({
          x: layout.row.x + layout.row.width - 124 * authoredScale,
          y: layout.row.y + 32 * authoredScale,
          width: 112 * authoredScale,
          height: 38 * authoredScale,
        }),
        kind: 'action',
        parentId: rowId,
      },
    ];
  });

  window.__visualReview = {
    surface: 'abilities loadout selected and toggled state',
    regions: [
      { id: 'loadout-panel', box: toScreenshotBox(snapshot.panel), kind: 'panel' },
      {
        id: 'ability-list',
        box: toScreenshotBox(snapshot.listViewport),
        kind: 'section',
        parentId: 'loadout-panel',
      },
      {
        id: 'loadout-footer',
        box: toScreenshotBox(snapshot.footer),
        kind: 'section',
        parentId: 'loadout-panel',
      },
      ...rowRegions,
    ],
    expect: {},
  };
  window.__visualReviewClip = {
    x: Math.floor(rect.left),
    y: Math.floor(rect.top),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };
  window.__visualReviewHoverPoint = null;
})();
