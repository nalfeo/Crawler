(async () => {
  const waitFor = async (selector) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const element = document.querySelector(selector);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`[ai-runner-side-panel] Timed out waiting for ${selector}`);
  };

  await waitFor('#ai-playback-dock');
  if (document.fonts?.ready) await document.fonts.ready;

  const header = document.getElementById('app-header');
  const stage = document.getElementById('lab-stage');
  const toggle = document.getElementById('controls-toggle');
  const controls = document.getElementById('lab-controls');
  if (header) header.style.display = 'none';
  if (stage) stage.style.display = 'none';
  if (toggle) toggle.style.display = 'none';
  if (!controls) throw new Error('[ai-runner-side-panel] Missing #lab-controls');

  controls.style.cssText = [
    'position:fixed',
    'inset:0',
    'width:100vw',
    'max-width:none',
    'height:100vh',
    'max-height:none',
    'padding:0',
    'overflow:auto',
    'background:#081120',
    'z-index:9999',
  ].join(';');

  for (const child of controls.children) {
    child.style.display = child.querySelector?.('#ai-playback-dock') ? '' : 'none';
  }

  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const regionFor = (id, selector, kind, parentId) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      id,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      kind,
      ...(parentId ? { parentId } : {}),
    };
  };

  const panel = regionFor('ai-runner-panel', '.ai-runner-panel', 'panel');
  const commandDeck = regionFor('command-deck', '#ai-playback-dock', 'panel');
  const primaryGroup = regionFor('primary-actions', '.runner-primary-actions', 'group');
  const speedGroup = regionFor('speed-presets', '.runner-speed-group', 'group');
  const telemetry = regionFor('decision-telemetry', '#ai-telemetry', 'panel');
  const required = [
    ['take-control', '#ai-manual-toggle', 'primary-actions'],
    ['pause-resume', '#ai-toggle-run', 'primary-actions'],
    ['restart', '#ai-restart-current', 'primary-actions'],
    ['speed-1x', '#ai-speed-1', 'speed-presets'],
    ['speed-4x', '#ai-speed-4', 'speed-presets'],
    ['speed-16x', '#ai-speed-16', 'speed-presets'],
  ];
  const regions = [panel, commandDeck, primaryGroup, speedGroup, telemetry].filter(Boolean);
  const flags = [];

  for (const [id, selector, parentId] of required) {
    const region = regionFor(id, selector, 'control', parentId);
    if (!region) {
      flags.push(`Missing primary control: ${id}`);
      continue;
    }
    regions.push(region);
    const { x, y, width, height } = region.box;
    if (x < 0 || y < 0 || x + width > innerWidth || y + height > innerHeight) {
      flags.push(`Primary control outside 360x900 viewport: ${id}`);
    }
    const hit = document.elementFromPoint(x + width / 2, y + height / 2);
    const expected = document.querySelector(selector);
    if (expected && hit !== expected && !expected.contains(hit)) {
      flags.push(`Primary control center is not clickable: ${id}`);
    }
  }

  window.__visualReview = {
    surface: 'AI Runner side panel',
    regions,
    expect: {},
    flags,
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
  console.log(
    `[ai-runner-side-panel] regions=${regions.length} flags=${flags.length} viewport=${innerWidth}x${innerHeight}`,
  );
})();
