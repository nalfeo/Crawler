// Deterministic standalone-inventory scenarios for tracked A|B review.
(async () => {
  if (document.fonts?.ready) await document.fonts.ready;
  const probe = window.__uiProbe;
  const scenario = new URLSearchParams(window.location.search).get('uxScenario');
  const scenarios = new Set([
    'inventory-no-tooltip-or-filters',
    'inventory-tooltip',
    'inventory-tab-filtering',
    'inventory-text-filtering',
    'inventory-lots-of-items',
  ]);
  if (!scenarios.has(scenario)) {
    throw new Error(`Unknown inventory UX scenario: ${scenario ?? '<missing>'}`);
  }

  await probe?.useRealGeneratedSprites?.();
  if (typeof probe?.seedMixedInventory === 'function') {
    probe.seedMixedInventory(scenario === 'inventory-lots-of-items' ? 'lots' : 'standard');
  } else if (scenario === 'inventory-lots-of-items') {
    // Legacy A-side revisions can still exercise overflow through the older
    // equipment-only probe even though they predate the mixed-loot seed.
    probe?.seedOverflowBag?.(40);
  }
  probe?.openInventory?.();

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

  if (scenario === 'inventory-tab-filtering') {
    if (typeof probe?.setInventoryTagFilter === 'function') {
      probe.setInventoryTagFilter('Materials');
    } else {
      const tabs = probe?.getInventoryTabBounds?.() ?? [];
      const tab = tabs[1];
      const canvas = document.querySelector('canvas');
      const game = probe?.getGameSize?.();
      if (tab && canvas && game) {
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + (tab.x + tab.width / 2) * (rect.width / game.width);
        const clientY = rect.top + (tab.y + tab.height / 2) * (rect.height / game.height);
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX,
            clientY,
            button: 0,
            buttons: 1,
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
          }),
        );
        canvas.dispatchEvent(
          new PointerEvent('pointerup', {
            clientX,
            clientY,
            button: 0,
            buttons: 0,
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } else if (scenario === 'inventory-text-filtering') {
    if (typeof probe?.setInventorySearchQuery === 'function') {
      probe.setInventorySearchQuery('iron');
    } else {
      const canvas = document.querySelector('canvas');
      for (const key of 'iron') {
        for (const target of [window, document, canvas].filter(Boolean)) {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  let visibleIndices = probe?.getInventoryVisibleCellIndices?.() ?? [];
  const hoverIndex = visibleIndices[0];
  if (scenario === 'inventory-tooltip') {
    if (hoverIndex === undefined) {
      throw new Error('Unable to render the inventory tooltip state.');
    }
    if (typeof probe?.previewInventoryCell === 'function') {
      if (!probe.previewInventoryCell(hoverIndex)) {
        throw new Error('Unable to render the inventory tooltip state.');
      }
    } else {
      const box = probe?.getInventoryCellBounds?.(hoverIndex);
      const canvas = document.querySelector('canvas');
      const game = probe?.getGameSize?.();
      if (!box || !canvas || !game) {
        throw new Error('Unable to locate the legacy inventory hover target.');
      }
      const rect = canvas.getBoundingClientRect();
      window.__visualReviewHoverPoint = {
        x: rect.left + (box.x + box.width / 2) * (rect.width / game.width),
        y: rect.top + (box.y + box.height / 2) * (rect.height / game.height),
      };
    }
  }

  visibleIndices = probe?.getInventoryVisibleCellIndices?.() ?? [];
  const visibleItemIds = probe?.getInventoryVisibleItemIds?.() ?? [];
  const filterState = probe?.getInventoryFilterState?.();
  const composition = probe?.getInventoryComposition?.();
  const hasRegionProbe = typeof probe?.getInventoryPanelBounds === 'function';
  const panel = probe?.getInventoryPanelBounds?.();
  const tabs = probe?.getInventoryTabBounds?.() ?? [];
  const search = probe?.getInventorySearchBounds?.();
  const sort = probe?.getInventorySortBounds?.();
  const tooltip = probe?.getInventoryTooltipBounds?.();
  const scrollUp = probe?.getInventoryScrollUpControlBounds?.();
  const scrollDown = probe?.getInventoryScrollDownControlBounds?.();
  const cells = visibleIndices
    .map((index) => ({ index, box: probe?.getInventoryCellBounds?.(index) }))
    .filter((entry) => entry.box);
  const flags = [];
  const regions = [];

  if (panel) regions.push({ id: 'inventory-panel', box: panel, kind: 'panel' });
  else if (hasRegionProbe) flags.push('Inventory panel bounds are unavailable.');

  tabs.forEach((box, index) => {
    regions.push({ id: `tab:${index}`, box, kind: 'control', parentId: 'inventory-controls' });
  });
  if (hasRegionProbe && tabs.length === 0) flags.push('Inventory has no visible tab controls.');
  if (search) {
    regions.push({
      id: 'search-control',
      box: search,
      kind: 'control',
      parentId: 'inventory-controls',
    });
  } else if (hasRegionProbe) flags.push('Inventory search control bounds are unavailable.');
  if (sort) {
    regions.push({
      id: 'sort-control',
      box: sort,
      kind: 'control',
      parentId: 'inventory-controls',
    });
  } else if (hasRegionProbe) flags.push('Inventory sort control bounds are unavailable.');

  if (cells.length > 0) {
    const minX = Math.min(...cells.map(({ box }) => box.x));
    const minY = Math.min(...cells.map(({ box }) => box.y));
    const maxX = Math.max(...cells.map(({ box }) => box.x + box.width));
    const maxY = Math.max(...cells.map(({ box }) => box.y + box.height));
    regions.push({
      id: 'inventory-grid',
      box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      kind: 'panel',
    });
    cells.forEach(({ index, box }) => {
      regions.push({ id: `cell:${index}`, box, kind: 'slot', parentId: 'inventory-grid' });
    });
  } else {
    flags.push('Inventory scenario rendered no visible grid cells.');
  }

  if (scenario === 'inventory-lots-of-items') {
    if (scrollUp) regions.push({ id: 'scroll-up', box: scrollUp, kind: 'control' });
    if (scrollDown) regions.push({ id: 'scroll-down', box: scrollDown, kind: 'control' });
    if ((probe?.getInventoryMaxScrollRow?.() ?? 0) <= 0) {
      flags.push('Lots-of-items scenario does not overflow the visible grid.');
    }
    if (hasRegionProbe && !scrollDown) {
      flags.push('Lots-of-items scenario has no visible scroll-down control.');
    }
  }

  if (scenario === 'inventory-tooltip') {
    const hoverTarget = cells.find(({ index }) => index === hoverIndex)?.box;
    if (hoverTarget) {
      regions.push({
        id: `hover-target:cell:${hoverIndex}`,
        box: hoverTarget,
        kind: 'slot',
        parentId: 'hover-context',
      });
    } else flags.push('Inventory hover target bounds are unavailable.');
    if (tooltip) {
      regions.push({
        id: 'inventory-tooltip',
        box: tooltip,
        kind: 'tooltip',
        parentId: 'hover-context',
      });
    } else if (hasRegionProbe) flags.push('Inventory tooltip scenario did not render a tooltip.');
  } else if (tooltip) {
    flags.push(`${scenario} unexpectedly rendered a tooltip.`);
  }

  if (
    scenario === 'inventory-no-tooltip-or-filters' &&
    filterState &&
    (filterState.tag !== null || filterState.query !== '')
  ) {
    flags.push('Default scenario unexpectedly has an active filter.');
  }
  if (scenario === 'inventory-tab-filtering' && filterState && filterState.tag !== 'Materials') {
    flags.push('Tab-filtering scenario did not activate the Materials tab.');
  }
  if (scenario === 'inventory-text-filtering') {
    if (filterState && filterState.query !== 'iron') {
      flags.push('Text-filtering scenario query is not "iron".');
    }
    if (visibleItemIds.some((id) => !id.includes('iron'))) {
      flags.push('Text-filtering scenario includes an item outside the "iron" result set.');
    }
  }
  if (
    composition &&
    (composition.equipment === 0 || composition.materials === 0 || composition.otherLoot === 0)
  ) {
    flags.push('Inventory fixture does not mix equipment, materials, and other loot.');
  }

  const contains = (outer, inner) =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  if (panel) {
    for (const region of regions) {
      if (
        region.id !== 'inventory-panel' &&
        region.parentId !== 'inventory-grid' &&
        !contains(panel, region.box)
      ) {
        flags.push(`${region.id} escapes the inventory panel.`);
      }
    }
  }

  const surfaceNames = {
    'inventory-no-tooltip-or-filters': 'Inventory (No tooltip or filters)',
    'inventory-tooltip': 'Inventory (Tooltip)',
    'inventory-tab-filtering': 'Inventory (Tab filtering)',
    'inventory-text-filtering': 'Inventory (Text filtering)',
    'inventory-lots-of-items': 'Inventory (Lots of items)',
  };
  window.__visualReview = {
    surface: surfaceNames[scenario],
    regions,
    expect: {},
    flags,
  };
  window.__visualReviewClip = null;
  if (typeof probe?.previewInventoryCell === 'function') {
    window.__visualReviewHoverPoint = null;
  }
})();
