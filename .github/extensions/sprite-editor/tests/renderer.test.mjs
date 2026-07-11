import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { renderHtml } from '../renderer.mjs';

const TWO_BY_TWO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR42mP4DwQMIAAkG4DkfwBLSQd6Nhz6dgAAAABJRU5ErkJggg==',
  'base64',
);

const SPRITE = {
  key: 'fixture-sprite',
  label: 'Fixture Sprite',
  assetPath: 'generated/fixture-sprite.png',
  variantGroup: 'fixture',
  variantCount: 2,
  variantPosition: 1,
  nextVariantKey: 'fixture-sprite-2',
  prevVariantKey: null,
  favorite: false,
  placeholder: false,
  holdX: 0,
  holdY: 0,
  pivotX: 0,
  pivotY: 0,
  frame: 0,
  col: 0,
  row: 0,
  facingDirection: 'right',
  comment: '',
};

const SECOND_SPRITE = {
  ...SPRITE,
  key: 'fixture-sprite-2',
  label: 'Second Fixture',
  assetPath: 'generated/fixture-sprite-2.png',
  variantPosition: 2,
  nextVariantKey: null,
  prevVariantKey: 'fixture-sprite',
  favorite: false,
};

async function withEditor(run, options = {}) {
  const html = renderHtml('test');
  const fixtureSprites = [structuredClone(SPRITE), structuredClone(SECOND_SPRITE)];
  let currentPng = TWO_BY_TWO_PNG;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sprites: fixtureSprites,
          total: fixtureSprites.length,
          availableTags: [],
        }),
      );
      return;
    }
    if (url.pathname === '/api/sprite') {
      const sprite = fixtureSprites.find((entry) => entry.key === url.searchParams.get('key'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sprite }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/save') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const respond = () => {
          const payload = JSON.parse(body);
          const index = fixtureSprites.findIndex((entry) => entry.key === payload.key);
          if (index >= 0) {
            fixtureSprites[index] = {
              ...fixtureSprites[index],
              ...payload.metadata,
              ...payload.annotation,
            };
          }
          if (typeof payload.pngDataUrl === 'string') {
            currentPng = Buffer.from(payload.pngDataUrl.split(',')[1], 'base64');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sprite: fixtureSprites[index] }));
        };
        if (options.saveDelayMs) setTimeout(respond, options.saveDelayMs);
        else respond();
      });
      return;
    }
    if (url.pathname === '/img/sprite') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(currentPng);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => {
      console.error('sprite editor page error:', error);
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    try {
      await page.waitForSelector('#tool-draw', { timeout: 5_000 });
    } catch (error) {
      console.error(
        'sprite editor body:',
        (await page.locator('body').innerText()).slice(0, 2_000),
      );
      throw error;
    }
    await run(page);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function rgba(r, g, b, a = 255) {
  return [r, g, b, a];
}

async function paintSprite(page, width, height, pixels) {
  await page.evaluate(
    ({ width: nextWidth, height: nextHeight, pixels: nextPixels }) => {
      const spriteCanvas = document.querySelector('.sprite-canvas');
      const overlayCanvas = document.querySelector('.overlay-canvas');
      const beforeCanvas = document.querySelector('#comparison-before-canvas');
      const imageData = new ImageData(new Uint8ClampedArray(nextPixels), nextWidth, nextHeight);
      spriteCanvas.width = nextWidth;
      spriteCanvas.height = nextHeight;
      spriteCanvas.style.width = `${nextWidth}px`;
      spriteCanvas.style.height = `${nextHeight}px`;
      const spriteCtx = spriteCanvas.getContext('2d');
      spriteCtx.clearRect(0, 0, nextWidth, nextHeight);
      spriteCtx.putImageData(imageData, 0, 0);
      if (overlayCanvas) {
        overlayCanvas.width = nextWidth;
        overlayCanvas.height = nextHeight;
        overlayCanvas.style.width = `${nextWidth}px`;
        overlayCanvas.style.height = `${nextHeight}px`;
        overlayCanvas.getContext('2d').clearRect(0, 0, nextWidth, nextHeight);
      }
      if (beforeCanvas) {
        beforeCanvas.width = nextWidth;
        beforeCanvas.height = nextHeight;
        beforeCanvas.style.width = `${nextWidth}px`;
        beforeCanvas.style.height = `${nextHeight}px`;
        const beforeCtx = beforeCanvas.getContext('2d');
        beforeCtx.clearRect(0, 0, nextWidth, nextHeight);
        beforeCtx.putImageData(imageData, 0, 0);
      }
    },
    { width, height, pixels },
  );
}

async function readCanvasPixels(page, selector = '.sprite-canvas') {
  return page.locator(selector).evaluate((element) => {
    const context = element.getContext('2d');
    return Array.from(context.getImageData(0, 0, element.width, element.height).data);
  });
}

async function clickCanvasPixel(page, x, y) {
  await page.evaluate(
    ({ x: pixelX, y: pixelY }) => {
      const element = document.querySelector('.sprite-canvas');
      const rect = element.getBoundingClientRect();
      const scaleX = rect.width / Math.max(1, element.width);
      const scaleY = rect.height / Math.max(1, element.height);
      element.onmousedown({
        button: 0,
        clientX: rect.left + (pixelX + 0.5) * scaleX,
        clientY: rect.top + (pixelY + 0.5) * scaleY,
      });
      window.onmouseup();
    },
    { x, y },
  );
}

async function setControlValue(page, selector, value) {
  await page.locator(selector).evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('sprite editor wires OpenCV scaling controls and methods', () => {
  const html = renderHtml('x');
  assert.match(html, /\/vendor\/opencv\.js/);
  assert.match(html, /SCALE_FACTOR_MIN = 0\.25/);
  assert.match(html, /SCALE_FACTOR_MAX = 8/);
  assert.match(html, /Nearest \(pixel-perfect\)/);
  assert.match(html, /Bilinear/);
  assert.match(html, /Bicubic/);
  assert.match(html, /Pixel-area \(best downscale\)/);
  assert.match(html, /Lanczos4/);
  assert.match(html, /Native dimensions:/);
  assert.match(html, /Scaling…/);
  assert.match(html, /inline-spinner/);
  assert.match(html, /function hasDirtyScaleSettings\(\)/);
  assert.match(html, /function hasDirtyEdgeCleanupSettings\(\)/);
  assert.match(html, /function hasDirtyBackgroundRemovalSettings\(\)/);
  assert.match(html, /function hasDirtyFringeNormalizeSettings\(\)/);
  assert.match(html, /var sampledBackgroundColor = null/);
  assert.match(html, /var sampledBackgroundPoint = null/);
  assert.match(html, /function resolveBackgroundReference\(imageData\)/);
  assert.match(html, /collectConnectedBackgroundMask/);
  assert.match(html, /applyFringeNormalize/);
  assert.match(html, /Normalize fringe/);
  assert.match(html, /Opaque average/);
  assert.match(html, /Majority neighbor/);
  assert.match(html, /Despill from background/);
  assert.doesNotMatch(html, /var fringeHelp =/);
  assert.match(html, /applyScaleBtn\.disabled = scaleInFlight \|\| !scaleDirty/);
  assert.match(html, /Edge cleanup/);
  assert.match(html, /Defringe/);
  assert.match(html, /Matte neutralize/);
  assert.match(html, /applyEdgeCleanup/);
  assert.match(html, /autoTuneCleanupFromBackgroundSample/);
  assert.match(html, /Pick background/);
  assert.match(html, /Tolerance widens the match/);
  assert.match(html, /Defringe borrows nearby opaque color/);
  assert.doesNotMatch(html, /var edgeHelp =/);
  assert.doesNotMatch(html, /var backgroundHelp =/);
  assert.match(html, /Background/);
  assert.match(html, /Remove BG/);
  assert.match(html, /Flood-fill corners/);
  assert.match(html, /applyBackgroundRemoval/);
  assert.match(html, /Zoom to fit/);
  assert.match(html, /Anchor \+/);
  assert.match(html, /tool-btn icon-btn/);
  assert.match(html, /scaleWithWorker\(/);
  assert.match(html, /Scaling in background worker…/);
  assert.match(html, /Background scaler timed out\./);
  assert.match(html, /var ZOOM_MIN = 0\.5/);
  assert.match(html, /var ZOOM_STEP = 0\.5/);
  assert.match(html, /var pixelScale = 1/);
  assert.match(html, /var ZOOM_WHEEL_STEP = 0\.5/);
  assert.match(html, /function clampPixelScale\(value\)/);
  assert.match(html, /function zoomToFit\(canvasWrap\)/);
  assert.match(html, /canvasWrap\.addEventListener\(\s*'wheel'/);
  assert.match(html, /function resolveInterpolation\(cv, methodId, factor\)/);
  assert.match(html, /typeof self\.cv\.then === ["']function["']/);
  assert.match(html, /self\.cv = await Promise\.race/);
  assert.match(html, /if \(id === ["']area["']\) return factor < 1 \? cv\.INTER_AREA/);
  assert.match(html, /cv\.resize\(src, dst, dsize, 0, 0, interpolation\)/);
  assert.match(html, /class: 'app-bar'/);
  assert.match(html, /class: 'tool-rail'/);
  assert.match(html, /class: 'tool-panel'/);
  assert.match(html, /var activeEditorTool = 'draw'/);
  assert.match(html, /previousEditorTool/);
  assert.match(html, /comparisonBeforeCanvas/);
  assert.match(html, /captureLastSavedSnapshot/);
  assert.doesNotMatch(html, /captureComparisonBefore/);
  assert.match(html, /id: 'dislike-button'/);
  assert.match(html, /'aria-label': 'Like as exemplar'/);
  assert.match(html, /'aria-label': 'Dislike and flag for regeneration'/);
  assert.match(html, /role: 'status'/);
  assert.doesNotMatch(html, /id="app" aria-live/);
});

test('sprite editor keeps every edit action within two clicks and preserves tool state', async () => {
  await withEditor(async (page) => {
    const matrix = [
      ['draw', 'Erase pixels', '#brush-size'],
      ['scale', 'Scale sprite', '#scale-factor'],
      ['edge', 'Edge cleanup', '#edge-cleanup-method'],
      ['background', 'Background removal', '#background-removal-method'],
      ['fringe', 'Fringe palette', '#fringe-normalize-method'],
      ['anchor', 'Anchor & overlays', 'text=Set anchor by click'],
    ];

    for (const [tool, title, action] of matrix) {
      await page.locator(`#tool-${tool}`).click();
      assert.equal(await page.locator(`#tool-${tool}`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#active-tool-title').textContent(), title);
      await page.locator(action).first().waitFor({ state: 'visible' });
    }
    await page.locator('[aria-label="Before edit"]').waitFor({ state: 'visible' });
    await page.locator('[aria-label="After edit"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#comparison-before-label').textContent(), 'Last saved');

    const quickActions = [
      'Zoom to fit',
      'Erase mode',
      'Eyedropper',
      'Pick background',
      'Set anchor by click',
    ];
    for (const label of quickActions) {
      await page.getByTitle(label).first().waitFor({ state: 'visible' });
    }

    await page.keyboard.press('s');
    assert.equal(await page.locator('#tool-scale').getAttribute('aria-pressed'), 'true');
    await page.locator('#scale-factor').focus();
    await page.locator('#scale-factor').evaluate((element) => {
      element.value = '2';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.locator('#tool-scale').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'scale-factor');

    await page.locator('#scale-factor').evaluate((element) => element.blur());
    await page.keyboard.press('e');
    assert.equal(await page.locator('#tool-edge').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('q');
    assert.equal(await page.locator('#tool-scale').getAttribute('aria-pressed'), 'true');

    await page.getByTitle('Pick background').click();
    assert.equal(
      await page.getByTitle('Background picker active').getAttribute('aria-pressed'),
      'true',
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.getByTitle('Pick background').getAttribute('aria-pressed'), 'false');

    assert.equal(await page.locator('#app').getAttribute('aria-live'), null);
    assert.equal(await page.locator('#status').getAttribute('role'), 'status');
    assert.equal(await page.locator('#zoom-level').getAttribute('aria-label'), 'Zoom level');
    assert.equal(await page.locator('#draw-color').getAttribute('aria-label'), 'Draw color');

    await page.locator('#tool-edge').click();
    assert.equal(
      await page.locator('.tool-panel').getByRole('button', { name: 'Edge cleanup' }).isEnabled(),
      true,
    );
    await page.locator('#tool-background').click();
    assert.equal(
      await page.locator('.tool-panel').getByRole('button', { name: 'Remove BG' }).isEnabled(),
      true,
    );
    await page.locator('#tool-fringe').click();
    assert.equal(
      await page
        .locator('.tool-panel')
        .getByRole('button', { name: 'Normalize fringe' })
        .isEnabled(),
      true,
    );

    const brushStroke = async (x, y) => {
      await page.evaluate(
        ({ x: pixelX, y: pixelY }) => {
          const element = document.querySelector('.sprite-canvas');
          const rect = element.getBoundingClientRect();
          element.onmousedown({
            button: 0,
            clientX: rect.left + pixelX + 0.5,
            clientY: rect.top + pixelY + 0.5,
          });
          window.onmouseup();
        },
        { x, y },
      );
    };
    const savedBefore = await page
      .locator('#comparison-before-canvas')
      .evaluate((element) => element.toDataURL());
    await brushStroke(0, 0);
    await brushStroke(1, 0);
    assert.equal(await page.locator('#comparison-before-label').textContent(), 'Last saved');
    assert.equal(
      await page.locator('#comparison-before-canvas').evaluate((element) => element.toDataURL()),
      savedBefore,
    );

    await page.locator('#tool-edge').click();
    await page.locator('#edge-cleanup-amount').evaluate((element) => {
      element.value = '61';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'Edge cleanup' }).click();
    assert.equal(await page.getByRole('button', { name: 'Edge cleanup' }).isEnabled(), false);
    assert.equal(await page.locator('#comparison-before-label').textContent(), 'Last saved');

    await brushStroke(0, 1);
    assert.equal(await page.getByRole('button', { name: 'Edge cleanup' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await page.getByRole('button', { name: 'Edge cleanup' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Redo' }).click();
    assert.equal(
      await page.locator('#comparison-before-canvas').evaluate((element) => element.toDataURL()),
      savedBefore,
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(
      () => document.querySelector('#status')?.textContent === 'Saved to disk.',
    );
    assert.equal(
      await page.locator('#comparison-before-canvas').evaluate((element) => element.toDataURL()),
      await page.locator('.sprite-canvas').evaluate((element) => element.toDataURL()),
    );

    await page.locator('.sprite-canvas').evaluate((element) => {
      element.style.width = '1200px';
    });
    await page.locator('#comparison-before-canvas').evaluate((element) => {
      element.style.width = '1200px';
    });
    await page.locator('[data-canvas-wrap]').evaluate((element) => {
      element.scrollLeft = 180;
    });
    assert.equal(
      await page.locator('[data-canvas-wrap]').evaluate((element) => element.scrollLeft),
      180,
    );
    await page.locator('#tool-fringe').click();
    assert.equal(
      await page.locator('[data-canvas-wrap]').evaluate((element) => element.scrollLeft),
      180,
    );
  });
});

test('scaling restores dimensions, pixels, and anchors through undo and redo', async () => {
  await withEditor(async (page) => {
    const readCanvas = (selector) =>
      page.locator(selector).evaluate((element) => {
        const context = element.getContext('2d');
        return {
          width: element.width,
          height: element.height,
          pixels: Array.from(context.getImageData(0, 0, element.width, element.height).data),
        };
      });
    const initial = await readCanvas('.sprite-canvas');

    await page.locator('#tool-scale').click();
    await page.evaluate(() => {
      document.querySelector('#holdX').value = '1';
      document.querySelector('#holdY').value = '1';
      document.querySelector('#pivotX').value = '1';
      document.querySelector('#pivotY').value = '1';
    });
    await page.locator('#scale-factor').evaluate((element) => {
      element.value = '2';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('.sprite-canvas')?.width === 4 &&
        document.querySelector('#status')?.textContent.startsWith('Scaled from'),
    );

    const scaled = await readCanvas('.sprite-canvas');
    assert.deepEqual([scaled.width, scaled.height], [4, 4]);
    assert.deepEqual(
      await page.locator('.overlay-canvas').evaluate((element) => [element.width, element.height]),
      [4, 4],
    );
    for (let y = 0; y < scaled.height; y += 1) {
      for (let x = 0; x < scaled.width; x += 1) {
        const sourceOffset = (Math.floor(y / 2) * initial.width + Math.floor(x / 2)) * 4;
        const scaledOffset = (y * scaled.width + x) * 4;
        assert.deepEqual(
          scaled.pixels.slice(scaledOffset, scaledOffset + 4),
          initial.pixels.slice(sourceOffset, sourceOffset + 4),
        );
      }
    }
    assert.deepEqual(
      await page.evaluate(() =>
        ['holdX', 'holdY', 'pivotX', 'pivotY'].map((id) => document.querySelector(`#${id}`).value),
      ),
      ['2', '2', '2', '2'],
    );
    assert.equal(
      await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).isEnabled(),
      true,
    );

    await page.getByRole('button', { name: 'Undo' }).click();
    assert.deepEqual(await readCanvas('.sprite-canvas'), initial);
    assert.deepEqual(
      await page.locator('.overlay-canvas').evaluate((element) => [element.width, element.height]),
      [2, 2],
    );
    assert.deepEqual(
      await page.evaluate(() =>
        ['holdX', 'holdY', 'pivotX', 'pivotY'].map((id) => document.querySelector(`#${id}`).value),
      ),
      ['1', '1', '1', '1'],
    );
    assert.equal(
      await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).isEnabled(),
      true,
    );

    await page.getByRole('button', { name: 'Redo' }).click();
    assert.deepEqual(await readCanvas('.sprite-canvas'), scaled);
    assert.deepEqual(
      await page.evaluate(() =>
        ['holdX', 'holdY', 'pivotX', 'pivotY'].map((id) => document.querySelector(`#${id}`).value),
      ),
      ['2', '2', '2', '2'],
    );
    assert.equal(
      await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).isEnabled(),
      true,
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(
      () => document.querySelector('#status')?.textContent === 'Saved to disk.',
    );
    await page.getByRole('button', { name: /Second Fixture/ }).click();
    await page.waitForFunction(
      () => document.querySelector('.sprite-title')?.textContent === 'Second Fixture',
    );
    assert.equal(
      await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).isEnabled(),
      true,
    );
  });
});

test('save preserves edits made while the request is in flight', async () => {
  await withEditor(
    async (page) => {
      await page.getByTitle('Erase mode').click();
      await clickCanvasPixel(page, 0, 0);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Saving…',
      );
      await clickCanvasPixel(page, 1, 0);
      await page.waitForFunction(
        () =>
          document.querySelector('#status')?.textContent ===
          'Saved submitted state; newer edits remain unsaved.',
      );

      let dialogMessage = '';
      page.on('dialog', async (dialog) => {
        if (!dialogMessage) dialogMessage = dialog.message();
        await dialog.dismiss();
      });
      await page.getByRole('button', { name: /Second Fixture/ }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Stayed on current sprite.',
      );
      assert.match(dialogMessage, /Unsaved edits detected/);
      assert.equal(await page.locator('.sprite-title').textContent(), 'Fixture Sprite');
    },
    { saveDelayMs: 200 },
  );
});

test('stale scaling results cannot overwrite a newly selected sprite', async () => {
  await withEditor(async (page) => {
    await page.evaluate(() => {
      window.Worker = class DelayedFailureWorker {
        listeners = {};

        addEventListener(type, listener) {
          this.listeners[type] = listener;
        }

        postMessage() {
          setTimeout(() => this.listeners.error?.(new Event('error')), 150);
        }

        terminate() {}
      };
    });
    await page.locator('#tool-scale').click();
    await page.locator('#scale-factor').evaluate((element) => {
      element.value = '2';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).click();
    await page.getByRole('button', { name: /Second Fixture/ }).click();
    await page.waitForFunction(
      () => document.querySelector('.sprite-title')?.textContent === 'Second Fixture',
    );
    await page.waitForTimeout(250);

    assert.deepEqual(
      await page.locator('.sprite-canvas').evaluate((element) => [element.width, element.height]),
      [2, 2],
    );
    assert.equal(await page.locator('.sprite-title').textContent(), 'Second Fixture');
  });
});

test('stale scaling results cannot overwrite a mid-flight edit', async () => {
  await withEditor(async (page) => {
    await page.evaluate(() => {
      window.Worker = class DelayedFailureWorker {
        listeners = {};

        addEventListener(type, listener) {
          this.listeners[type] = listener;
        }

        postMessage() {
          setTimeout(() => this.listeners.error?.(new Event('error')), 150);
        }

        terminate() {}
      };
    });

    await page.locator('#tool-scale').click();
    await page.locator('#scale-factor').evaluate((element) => {
      element.value = '2';
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const beforeScale = await page.locator('.sprite-canvas').evaluate((element) => {
      const context = element.getContext('2d');
      return {
        width: element.width,
        height: element.height,
        firstPixel: Array.from(context.getImageData(0, 0, 1, 1).data),
      };
    });
    await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).click();

    await page.evaluate(() => {
      const element = document.querySelector('.sprite-canvas');
      const rect = element.getBoundingClientRect();
      const drawBtn = document.querySelector('#tool-draw');
      if (drawBtn) drawBtn.click();
      element.onmousedown({
        button: 0,
        clientX: rect.left + 0.5,
        clientY: rect.top + 0.5,
      });
    });

    await page.waitForTimeout(300);

    assert.deepEqual(
      await page.locator('.sprite-canvas').evaluate((element) => [element.width, element.height]),
      [beforeScale.width, beforeScale.height],
    );
    assert.notDeepEqual(
      await page
        .locator('.sprite-canvas')
        .evaluate((element) => Array.from(element.getContext('2d').getImageData(0, 0, 1, 1).data)),
      beforeScale.firstPixel,
    );
    const status = await page.locator('#status').textContent();
    assert.ok(
      !status.startsWith('Scaled from'),
      `Expected no scale-completion message, got: ${status}`,
    );
    await page.evaluate(() => window.onmouseup());
  });
});

test('mutually exclusive reactions stay scoped to the sprite being edited', async () => {
  await withEditor(async (page) => {
    const heart = page.locator('#favorite-heart');
    const dislike = page.locator('#dislike-button');
    assert.equal(await heart.getAttribute('aria-label'), 'Like as exemplar');
    assert.equal(await dislike.getAttribute('aria-label'), 'Dislike and flag for regeneration');
    assert.equal(await heart.getAttribute('aria-pressed'), 'false');
    assert.equal(await dislike.getAttribute('aria-pressed'), 'false');
    await heart.click();
    assert.equal(await heart.getAttribute('aria-pressed'), 'true');
    assert.equal(await dislike.getAttribute('aria-pressed'), 'false');
    await dislike.click();
    assert.equal(await heart.getAttribute('aria-pressed'), 'false');
    assert.equal(await dislike.getAttribute('aria-pressed'), 'true');

    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: /Second Fixture/ }).click();
    await page.waitForFunction(
      () => document.querySelector('.sprite-title')?.textContent === 'Second Fixture',
    );
    assert.equal(await page.locator('#favorite-heart').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#dislike-button').getAttribute('aria-pressed'), 'false');

    await page
      .getByRole('button', { name: /Fixture Sprite/ })
      .first()
      .click();
    await page.waitForFunction(
      () => document.querySelector('.sprite-title')?.textContent === 'Fixture Sprite',
    );
    assert.equal(await page.locator('#favorite-heart').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#dislike-button').getAttribute('aria-pressed'), 'true');
  });
});

test('sampled flood-fill removes every reachable background pixel despite rejected neighbors', async () => {
  await withEditor(async (page) => {
    await paintSprite(page, 3, 4, [
      ...rgba(255, 255, 255),
      ...rgba(255, 255, 255),
      ...rgba(255, 255, 255),
      ...rgba(12, 12, 12),
      ...rgba(12, 12, 12),
      ...rgba(255, 255, 255),
      ...rgba(12, 12, 12),
      ...rgba(255, 255, 255),
      ...rgba(255, 255, 255),
      ...rgba(255, 255, 255),
      ...rgba(255, 255, 255),
      ...rgba(12, 12, 12),
    ]);
    await page.getByTitle('Pick background').click();
    await clickCanvasPixel(page, 0, 0);
    await page.locator('#tool-background').click();
    await setControlValue(page, '#background-removal-method', 'flood-fill');
    await setControlValue(page, '#background-removal-tolerance', 0);
    await setControlValue(page, '#background-removal-softness', 0);
    await page.locator('.tool-panel').getByRole('button', { name: 'Remove BG' }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('#status')?.textContent ===
        'Background removal sampled-region applied.',
    );

    const pixels = await readCanvasPixels(page);
    const alphaAt = (x, y) => pixels[(y * 3 + x) * 4 + 3];
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 2],
      [2, 2],
      [0, 3],
      [1, 3],
    ]) {
      assert.equal(alphaAt(x, y), 0, `expected sampled flood-fill to clear ${x},${y}`);
    }
    for (const [x, y] of [
      [0, 1],
      [1, 1],
      [0, 2],
      [2, 3],
    ]) {
      assert.equal(alphaAt(x, y), 255, `expected solid pixel ${x},${y} to remain opaque`);
    }
  });
});

test('sampled background still honors color-key as a global removal method', async () => {
  await withEditor(async (page) => {
    await paintSprite(page, 4, 2, [
      ...rgba(0, 180, 255),
      ...rgba(0, 180, 255),
      ...rgba(160, 40, 40),
      ...rgba(160, 40, 40),
      ...rgba(160, 40, 40),
      ...rgba(160, 40, 40),
      ...rgba(160, 40, 40),
      ...rgba(0, 180, 255),
    ]);
    await page.getByTitle('Pick background').click();
    await clickCanvasPixel(page, 0, 0);
    await page.locator('#tool-background').click();
    await setControlValue(page, '#background-removal-method', 'color-key');
    await setControlValue(page, '#background-removal-tolerance', 0);
    await setControlValue(page, '#background-removal-softness', 0);
    await page.locator('.tool-panel').getByRole('button', { name: 'Remove BG' }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('#status')?.textContent === 'Background removal color-key applied.',
    );

    const pixels = await readCanvasPixels(page);
    const alphaAt = (x, y) => pixels[(y * 4 + x) * 4 + 3];
    assert.equal(alphaAt(0, 0), 0);
    assert.equal(alphaAt(1, 0), 0);
    assert.equal(alphaAt(3, 1), 0, 'disconnected sampled color should be removed by color-key');
    assert.equal(alphaAt(2, 0), 255);
    assert.equal(alphaAt(1, 1), 255);
  });
});

test('despill uses its own background-push target instead of opaque-average neighbors', async () => {
  await withEditor(async (page) => {
    await paintSprite(page, 4, 4, [
      ...rgba(0, 255, 0),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(0, 0, 0, 0),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(20, 220, 20),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
    ]);
    await page.getByTitle('Pick background').click();
    await clickCanvasPixel(page, 0, 0);
    await page.locator('#tool-fringe').click();
    await setControlValue(page, '#fringe-normalize-method', 'despill');
    await setControlValue(page, '#fringe-normalize-strength', 100);
    await setControlValue(page, '#fringe-normalize-threshold', 40);
    await page.locator('.tool-panel').getByRole('button', { name: 'Normalize fringe' }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('#status')
        ?.textContent?.startsWith('Fringe normalize despill applied to '),
    );

    const pixels = await readCanvasPixels(page);
    const offset = (2 * 4 + 2) * 4;
    assert.deepEqual(pixels.slice(offset, offset + 4), [40, 185, 40, 255]);
  });
});
