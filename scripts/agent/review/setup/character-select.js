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

  window.__visualReview = {
    surface: 'Character Select',
    regions: [
      { id: 'character-panel', box: { x: 290, y: 126, width: 700, height: 468 }, kind: 'panel' },
      {
        id: 'director-commentary',
        box: { x: 314, y: 210, width: 652, height: 96 },
        kind: 'content',
      },
      { id: 'contestant-name', box: toDesignBox(input.getBoundingClientRect()), kind: 'control' },
      {
        id: 'pronoun-controls',
        box: toDesignBox(fieldset.getBoundingClientRect()),
        kind: 'control',
      },
      { id: 'primary-action', box: { x: 500, y: 514, width: 280, height: 46 }, kind: 'action' },
    ],
    expect: {},
  };
  window.__visualReviewClip = null;
  window.__visualReviewHoverPoint = null;
})();
