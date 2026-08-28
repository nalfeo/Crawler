(async () => {
  if (document.fonts?.ready) await document.fonts.ready;

  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';

  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Character Select scenario could not find the game canvas');
  const canvasRect = canvas.getBoundingClientRect();
  const toDesignBox = (rect) => ({
    x: ((rect.left - canvasRect.left) / canvasRect.width) * 1280,
    y: ((rect.top - canvasRect.top) / canvasRect.height) * 720,
    width: (rect.width / canvasRect.width) * 1280,
    height: (rect.height / canvasRect.height) * 720,
  });

  let input;
  let fieldset;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    input = document.querySelector('input[aria-label="Player name"]');
    fieldset = document.querySelector('fieldset[aria-label="Player gender"]');
    if (input && fieldset) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!input || !fieldset) throw new Error('Character Select scenario controls are not ready');

  const nameBox = toDesignBox(input.getBoundingClientRect());
  const pronounBox = toDesignBox(fieldset.getBoundingClientRect());

  // Deterministic sensor: reconstruct each Phaser text label's own design-space
  // box from the same layout constants used by IntroScene.buildUI() so the
  // shared computeGeometryBlockers() overlap/containment check catches the
  // "label crowds its control" regression class (see 2026-08 fix widening the
  // label-to-control gap from 24px to 34px after this exact bug shipped twice).
  const labelHeight = 18;
  const nameLabelBox = {
    x: nameBox.x,
    y: nameBox.y - 34,
    width: 140,
    height: labelHeight,
  };
  const pronounLabelBox = {
    x: pronounBox.x,
    y: pronounBox.y - 34,
    width: 100,
    height: labelHeight,
  };

  window.__visualReview = {
    surface: 'Character Select',
    regions: [
      { id: 'character-panel', box: { x: 290, y: 122, width: 700, height: 476 }, kind: 'panel' },
      {
        id: 'director-commentary',
        box: { x: 314, y: 198, width: 652, height: 96 },
        kind: 'content',
      },
      { id: 'contestant-name-label', box: nameLabelBox, kind: 'text' },
      { id: 'contestant-name', box: nameBox, kind: 'control' },
      { id: 'pronoun-controls-label', box: pronounLabelBox, kind: 'text' },
      { id: 'pronoun-controls', box: pronounBox, kind: 'control' },
      { id: 'primary-action', box: { x: 500, y: 530, width: 280, height: 46 }, kind: 'action' },
    ],
    expect: {},
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
