import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { renderHtml } from '../renderer.mjs';

const EXTENSION_SOURCE = readFileSync(new URL('../extension.mjs', import.meta.url), 'utf8');
const FAKE_OPENCV_JS = String.raw`
  self.cv = Promise.resolve((function () {
    function Mat(data, width, height) {
      this.data = data || new Uint8ClampedArray();
      this.cols = width || 0;
      this.rows = height || 0;
    }
    Mat.prototype.delete = function () {};
    function Size(width, height) {
      this.width = width;
      this.height = height;
    }
    var cv = {
      Mat: Mat,
      Size: Size,
      INTER_NEAREST: 1,
      INTER_NEAREST_EXACT: 11,
      INTER_LINEAR: 2,
      INTER_LINEAR_EXACT: 12,
      INTER_CUBIC: 13,
      INTER_AREA: 14,
      INTER_LANCZOS4: 15
    };
    cv.matFromImageData = function (imageData) {
      return new Mat(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    };
    cv.resize = function (_src, dst, dsize, _fx, _fy, interpolation) {
      var pixels = new Uint8ClampedArray(dsize.width * dsize.height * 4);
      for (var offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = interpolation;
        pixels[offset + 3] = 255;
      }
      dst.data = pixels;
      dst.cols = dsize.width;
      dst.rows = dsize.height;
    };
    return cv;
  })());
`;
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

function normalizeSavedAnnotationForFixture(annotation) {
  // Keep this trim().slice(0, 1000) normalization in sync with applyAnnotationUpdate() in extension.mjs.
  return {
    ...annotation,
    comment:
      typeof annotation?.comment === 'string' ? annotation.comment.trim().slice(0, 1000) : '',
  };
}

// A resolvable promise for deterministic mock handshakes (no fixed-delay
// races): the mock resolves it to signal an event; the test resolves it to
// release a held response.
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Bound a mock-handshake wait so a broken run (e.g. revert never reaches its
// image reload) fails fast into withEditor's cleanup instead of hanging Chromium
// and the HTTP server indefinitely — a bare deferred has no timeout of its own.
function waitWithTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withEditor(run, options = {}) {
  const html = renderHtml('test');
  const fixtureSprites = [structuredClone(SPRITE), structuredClone(SECOND_SPRITE)];
  let currentPng = TWO_BY_TWO_PNG;
  // Per-key count of /img/sprite requests, so a test can gate only the RELOAD
  // (2nd+) fetch for a key without touching the initial page-load fetch.
  const imgRequestCounts = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/list') {
      // Count list refetches so a test can prove the revert post-loadImage guard
      // RETURNS (no terminal loadList) rather than falling through to the
      // terminal branch, which does an extra loadList — see the mid-reload
      // revert test.
      if (options.counters) options.counters.list += 1;
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
    if (url.pathname === '/vendor/opencv.js' && options.openCvFixture) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(FAKE_OPENCV_JS);
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
            const annotation = options.normalizeSavedComment
              ? normalizeSavedAnnotationForFixture(payload.annotation)
              : payload.annotation;
            fixtureSprites[index] = {
              ...fixtureSprites[index],
              ...payload.metadata,
              ...annotation,
            };
          }
          if (typeof payload.pngDataUrl === 'string') {
            currentPng = Buffer.from(payload.pngDataUrl.split(',')[1], 'base64');
          }
          const saveResponse = { sprite: fixtureSprites[index] };
          // Optionally simulate the sidecar's durable assets/queue push outcome so
          // tests can exercise the queue-failure surfacing (F-D / FIX 3).
          if (options.saveQueueStatus) {
            saveResponse.queue = { status: options.saveQueueStatus };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(saveResponse));
        };
        if (options.saveDelayMs) setTimeout(respond, options.saveDelayMs);
        else respond();
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/revert') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const respond = () => {
          const payload = JSON.parse(body);
          const sprite = fixtureSprites.find((entry) => entry.key === payload.key);
          const revertResponse = { sprite };
          // Optionally simulate the sidecar's durable assets/queue push outcome so
          // tests can exercise revert queue-failure surfacing (FIX 3 / FIX 6).
          if (options.revertQueueStatus) {
            revertResponse.queue = { status: options.revertQueueStatus };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(revertResponse));
        };
        if (options.revertDelayMs) setTimeout(respond, options.revertDelayMs);
        else respond();
      });
      return;
    }
    if (url.pathname === '/img/sprite') {
      const imgKey = url.searchParams.get('key') || '';
      imgRequestCounts[imgKey] = (imgRequestCounts[imgKey] || 0) + 1;
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(currentPng);
      };
      // Gate only the RELOAD (2nd+) image fetch for a key — never the initial
      // page-load fetch — so a test can deterministically hold a revert's
      // post-loadImage reload in flight: the mock resolves `started` the instant
      // the held request arrives (letting the test switch sprites only AFTER
      // revert has entered loadImage → the post-loadImage path is guaranteed),
      // then waits for the test to resolve `release` before responding. This
      // explicit handshake replaces fixed-delay timing, removing the
      // reload/switch ordering races.
      const gate =
        options.imgGateByKey && imgRequestCounts[imgKey] > 1 ? options.imgGateByKey[imgKey] : null;
      if (gate) {
        gate.started.resolve();
        gate.release.promise.then(() => {
          try {
            respond();
          } catch {
            // The page/server may have torn down before release (e.g. a test
            // assertion threw); writing to a closed socket is a no-op we ignore.
          }
        });
      } else {
        respond();
      }
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
  assert.match(html, /MAX_SCALE_DIMENSION = 4096/);
  assert.match(html, /MAX_SCALE_PIXELS = 16 \* 1024 \* 1024/);
  assert.match(html, /MAX_HISTORY_BYTES = 64 \* 1024 \* 1024/);
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
  assert.match(EXTENSION_SOURCE, /if \(hasMetadata\) applyMetadataUpdate/);
  assert.match(EXTENSION_SOURCE, /if \(hasAnnotation\) applyAnnotationUpdate/);
  assert.match(EXTENSION_SOURCE, /if \(anchorChanged\)/);
  assert.match(EXTENSION_SOURCE, /entry\.contentHash = sha256Hex\(bytes\)/);
  assert.match(
    EXTENSION_SOURCE,
    /if \(hasMetadata \|\| wrotePng\) {\s*writeShard\(key, data\.manifest\.entries\[key\]\)/,
  );
});

test('sprite editor pins and verifies the OpenCV vendor asset', () => {
  assert.match(EXTENSION_SOURCE, /https:\/\/docs\.opencv\.org\/4\.13\.0/);
  assert.doesNotMatch(EXTENSION_SOURCE, /https:\/\/docs\.opencv\.org\/4\.x/);
  assert.match(
    EXTENSION_SOURCE,
    /63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0/,
  );
  assert.match(EXTENSION_SOURCE, /embeds its WASM payload in opencv\.js/);
  assert.match(EXTENSION_SOURCE, /path: \/\^\\\/vendor\\\/opencv\\\.js\$\//);
  assert.match(EXTENSION_SOURCE, /function sha256Hex\(value\)/);
  assert.match(EXTENSION_SOURCE, /const actualHash = sha256Hex\(body\)/);
  assert.match(EXTENSION_SOURCE, /vendor asset integrity check failed/);
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

test('keyboard activation preserves focus across rerendering quick actions', async () => {
  await withEditor(async (page) => {
    for (const id of [
      'draw-mode-toggle',
      'eyedropper-toggle',
      'background-picker-quick',
      'anchor-picker-quick',
    ]) {
      await page.locator(`#${id}`).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.id), id);
    }
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

test('Promise-based OpenCV worker executes every advertised interpolation mapping', async () => {
  await withEditor(
    async (page) => {
      await page.locator('#tool-scale').click();
      const cases = [
        { method: 'nearest', factor: 2, interpolation: 11 },
        { method: 'bilinear', factor: 2, interpolation: 12 },
        { method: 'bicubic', factor: 2, interpolation: 13 },
        { method: 'area', factor: 0.5, interpolation: 14 },
        { method: 'lanczos4', factor: 2, interpolation: 15 },
      ];

      for (const testCase of cases) {
        await setControlValue(page, '#scale-method', testCase.method);
        await setControlValue(page, '#scale-factor', testCase.factor);
        await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).click();
        try {
          await page.waitForFunction(
            () => document.querySelector('#status')?.textContent.endsWith('(OpenCV worker)'),
            null,
            { timeout: 5_000 },
          );
        } catch (error) {
          const status = await page.locator('#status').textContent();
          throw new Error(`${testCase.method} did not use OpenCV; status: ${status}`, {
            cause: error,
          });
        }
        assert.equal(
          await page
            .locator('.sprite-canvas')
            .evaluate((element) => element.getContext('2d').getImageData(0, 0, 1, 1).data[0]),
          testCase.interpolation,
          `${testCase.method} should reach cv.resize with its mapped interpolation`,
        );
        await page.getByRole('button', { name: 'Undo' }).click();
      }
    },
    { openCvFixture: true },
  );
});

test('Zoom to fit can shrink large sprites below the interactive zoom floor', async () => {
  await withEditor(async (page) => {
    await page.evaluate(() => {
      const canvasWrap = document.querySelector('[data-canvas-wrap]');
      Object.defineProperty(canvasWrap, 'clientWidth', { configurable: true, value: 500 });
      Object.defineProperty(canvasWrap, 'clientHeight', { configurable: true, value: 400 });
      for (const selector of ['.sprite-canvas', '.overlay-canvas', '#comparison-before-canvas']) {
        const canvas = document.querySelector(selector);
        canvas.width = 2048;
        canvas.height = 2048;
      }
    });
    await page.getByTitle('Zoom to fit').click();

    const fitted = await page.locator('.sprite-canvas').evaluate((element) => ({
      width: Number.parseFloat(element.style.width),
      height: Number.parseFloat(element.style.height),
    }));
    assert.ok(fitted.width <= 230, `expected fitted width <= 230px, got ${fitted.width}px`);
    assert.ok(fitted.height <= 356, `expected fitted height <= 356px, got ${fitted.height}px`);
    assert.ok(fitted.width < 2048 * 0.5, 'fit scale should be allowed below 0.5x');

    await page.locator('[data-canvas-wrap]').dispatchEvent('wheel', { deltaY: 100 });
    assert.equal(
      await page
        .locator('.sprite-canvas')
        .evaluate((element) => Number.parseFloat(element.style.width)),
      fitted.width,
      'zooming out below the interactive floor should be a no-op',
    );
    await page.locator('[data-canvas-wrap]').dispatchEvent('wheel', { deltaY: -100 });
    assert.equal(
      await page
        .locator('.sprite-canvas')
        .evaluate((element) => Number.parseFloat(element.style.width)),
      1024,
      'the first zoom-in should move to the 0.5x interactive floor',
    );
  });
});

test('scaling rejects target allocations above the safe pixel budget', async () => {
  await withEditor(async (page) => {
    await paintSprite(page, 4096, 1, new Array(4096 * 4).fill(255));
    await page.locator('#tool-scale').click();
    await setControlValue(page, '#scale-factor', 8);
    await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).click();

    assert.match(await page.locator('#status').textContent(), /exceeds the safe .* limit/);
    assert.deepEqual(
      await page.locator('.sprite-canvas').evaluate((element) => ({
        width: element.width,
        height: element.height,
      })),
      { width: 4096, height: 1 },
    );
  });
});

test('history evicts old full-frame snapshots to stay within its byte budget', async () => {
  await withEditor(async (page) => {
    await page.getByTitle('Erase mode').click();
    await page.evaluate(() => {
      const spriteCanvas = document.querySelector('.sprite-canvas');
      const overlayCanvas = document.querySelector('.overlay-canvas');
      spriteCanvas.width = 2048;
      spriteCanvas.height = 2048;
      overlayCanvas.width = 2048;
      overlayCanvas.height = 2048;
      spriteCanvas.getContext('2d').putImageData(new ImageData(2048, 2048), 0, 0);
    });
    for (let x = 0; x < 5; x += 1) {
      await clickCanvasPixel(page, x, 0);
    }

    for (let count = 0; count < 4; count += 1) {
      await page.keyboard.press('Control+z');
      assert.equal(await page.locator('#status').textContent(), 'Undo.');
    }
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('#status').textContent(), 'Nothing to undo.');
  });
});

test('pivot edits are synchronized to history so Undo does not discard them with image edits', async () => {
  await withEditor(async (page) => {
    await page.locator('#tool-scale').click();
    await setControlValue(page, '#scale-factor', 2);
    await page.locator('.tool-panel').getByRole('button', { name: 'Scale' }).click();
    await page.waitForFunction(() => document.querySelector('.sprite-canvas')?.width === 4);

    await setControlValue(page, '#pivotX', 1);
    assert.equal(await page.locator('#pivotX').inputValue(), '1');

    await page.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await page.locator('#pivotX').inputValue(), '0');
    assert.equal(await page.locator('.sprite-canvas').evaluate((element) => element.width), 4);

    await page.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await page.locator('.sprite-canvas').evaluate((element) => element.width), 2);
  });
});

test('form-only dirty checks reuse the cached canvas fingerprint', async () => {
  await withEditor(async (page) => {
    await page.locator('.sprite-canvas').evaluate((element) => {
      const originalToDataUrl = element.toDataURL.bind(element);
      window.__spriteFingerprintCalls = 0;
      element.toDataURL = (...args) => {
        window.__spriteFingerprintCalls += 1;
        return originalToDataUrl(...args);
      };
    });

    await page.locator('#comment').fill('a');
    await page.locator('#comment').fill('ab');
    await setControlValue(page, '#frame', 2);
    assert.equal(await page.evaluate(() => window.__spriteFingerprintCalls), 0);

    await page.getByTitle('Erase mode').click();
    await clickCanvasPixel(page, 0, 0);
    assert.equal(await page.evaluate(() => window.__spriteFingerprintCalls), 1);
  });
});

test('Unsaved badge tracks brush, comment, and reaction mutations immediately', async () => {
  await withEditor(async (page) => {
    const badge = page.locator('.dirty-badge');
    const unloadIsBlocked = () =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    assert.equal(await badge.count(), 0);
    assert.equal(await unloadIsBlocked(), false);

    await page.getByTitle('Erase mode').click();
    await clickCanvasPixel(page, 0, 0);
    assert.equal(await badge.textContent(), 'Unsaved');
    await page.keyboard.press('Control+z');
    assert.equal(await badge.count(), 0);

    await page.locator('#comment').fill('Needs another pass');
    assert.equal(await badge.textContent(), 'Unsaved');
    assert.equal(await unloadIsBlocked(), true);
    await page.locator('#comment').fill('');
    assert.equal(await badge.count(), 0);
    assert.equal(await unloadIsBlocked(), false);

    await page.locator('#favorite-heart').click();
    assert.equal(await badge.textContent(), 'Unsaved');
    await page.locator('#favorite-heart').click();
    assert.equal(await badge.count(), 0);
  });
});

test('save preserves edits made while the request is in flight', async () => {
  await withEditor(
    async (page) => {
      await page.getByTitle('Erase mode').click();
      await clickCanvasPixel(page, 0, 0);
      const submittedPng = await page
        .locator('.sprite-canvas')
        .evaluate((element) => element.toDataURL());
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Saving…',
      );
      assert.equal(await page.locator('#save-current').isDisabled(), true);
      assert.equal(await page.locator('#revert-current').isDisabled(), true);
      await clickCanvasPixel(page, 1, 0);
      await page.waitForFunction(
        () =>
          document.querySelector('#status')?.textContent ===
          'Saved submitted state; newer edits remain unsaved.',
      );
      assert.equal(await page.locator('#save-current').isDisabled(), false);
      assert.equal(await page.locator('#revert-current').isDisabled(), false);
      assert.equal(
        await page.locator('#comparison-before-canvas').evaluate((element) => element.toDataURL()),
        submittedPng,
      );
      assert.notEqual(
        await page.locator('.sprite-canvas').evaluate((element) => element.toDataURL()),
        submittedPng,
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

test('a failed durable queue push is surfaced even when the operator switches sprites mid-save', async () => {
  // FIX 3 / F-D completion: a durable assets/queue push can take seconds. If the
  // operator navigates to another sprite while it is in flight, the stale-token /
  // changed-key guards must NOT swallow a failed-push warning — otherwise the
  // worktree can be discarded with an un-persisted edit and the change is lost.
  await withEditor(
    async (page) => {
      // Save from a clean editor so the mid-save switch needs no unsaved-edits
      // dialog and stays deterministic. The delayed save still resolves stale
      // (sprite.key !== expectedKey) once we switch to the second fixture, which
      // is exactly the navigated-away-mid-push case FIX 3 must not swallow.
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Saving…',
      );
      await page.getByRole('button', { name: /Second Fixture/ }).click();
      // The clean switch (loadSprite) completes well before the delayed save
      // resolves, so the resolving save is genuinely stale.
      await page.waitForFunction(
        () => document.querySelector('.sprite-title')?.textContent === 'Second Fixture',
      );
      await page.waitForFunction(() =>
        (document.querySelector('#status')?.textContent ?? '').includes(
          'durable queue push FAILED',
        ),
      );
    },
    { saveDelayMs: 1000, saveQueueStatus: 'failed' },
  );
});

test('a failed durable queue push is surfaced on revert even when the operator switches sprites mid-revert', async () => {
  // FIX 6 (the revert half of FIX 3): revert also re-queues the reverted state
  // onto the durable assets/queue branch, and that push can take seconds. If the
  // operator navigates to another sprite while it is in flight, revert's
  // stale-token / changed-key guards must NOT swallow a failed-push warning —
  // otherwise the discarded edit silently resurfaces on the next reconcile.
  await withEditor(
    async (page) => {
      // Accept the "Revert to HEAD?" confirm; the later clean switch needs no
      // dialog, so a persistent accept handler stays deterministic.
      page.on('dialog', async (dialog) => {
        await dialog.accept();
      });
      await page.getByRole('button', { name: 'Revert' }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Reverting…',
      );
      await page.getByRole('button', { name: /Second Fixture/ }).click();
      // The clean switch (loadSprite) completes well before the delayed revert
      // resolves, so the resolving revert is genuinely stale
      // (sprite.key !== expectedKey) — the navigated-away-mid-push case.
      await page.waitForFunction(
        () => document.querySelector('.sprite-title')?.textContent === 'Second Fixture',
      );
      await page.waitForFunction(() =>
        (document.querySelector('#status')?.textContent ?? '').includes(
          'durable queue push FAILED',
        ),
      );
    },
    { revertDelayMs: 1000, revertQueueStatus: 'failed' },
  );
});

test('a failed durable queue push is surfaced when the operator switches sprites during revert’s image reload', async () => {
  // FIX 6, the SECOND async gap: revert stays NON-stale through /api/revert (no
  // switch has happened yet), so the stale-token guard is skipped entirely. The
  // operator then switches sprites while revert is awaiting its OWN image reload
  // (renderer.mjs loadImage at ~2447). Only the post-loadImage guard
  // (~2448-2452) surfaces the failed push on this path, because that guard
  // RETURNS before the terminal report — pre-FIX-6 the return dropped the
  // warning entirely.
  //
  // Fully synchronized (no fixed delays): a gate on the revert's image RELOAD
  // lets us (1) switch sprites only AFTER revert has entered loadImage
  // (guaranteeing the post-loadImage path, never the earlier stale-token guard),
  // and (2) release the held reload only AFTER the clean switch has settled on
  // 'Ready.' (so the FAILED warning can never be overwritten by a late 'Ready.').
  //
  // Non-vacuity — both mutations are killed deterministically:
  //  - Mutation B: removing ONLY the warning line inside the guard (keeping the
  //    return, i.e. the exact pre-FIX-6 code) leaves the status at 'Ready.' → the
  //    'durable queue push FAILED' wait times out.
  //  - Mutation A: removing the ENTIRE guard (warning + return) falls through to
  //    the terminal branch, which does an extra `await loadList()` (a /api/list
  //    refetch) before surfacing the warning → the list-count assertion fails.
  const revertReload = { started: deferred(), release: deferred() };
  const counters = { list: 0 };
  await withEditor(
    async (page) => {
      page.on('dialog', async (dialog) => {
        await dialog.accept();
      });
      await page.getByRole('button', { name: 'Revert' }).click();
      // /api/revert resolves immediately (non-stale), so revert advances into its
      // image reload. Wait until that RELOAD request has actually reached the
      // server before switching — this pins us to the post-loadImage path rather
      // than racing the earlier stale-token guard. Bounded so a revert that never
      // reaches loadImage fails fast into cleanup instead of hanging forever.
      await waitWithTimeout(
        revertReload.started.promise,
        15_000,
        'revert image reload to reach the server',
      );
      // Switch mid-reload: loadSprite bumps loadTokenCounter, tripping revert's
      // post-loadImage guard once the held reload resolves. Second Fixture's
      // image is its first request (not gated), so the switch completes.
      await page.getByRole('button', { name: /Second Fixture/ }).click();
      await page.waitForFunction(
        () => document.querySelector('.sprite-title')?.textContent === 'Second Fixture',
      );
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready.');
      // The clean switch has fully settled. Snapshot the list-refetch count, then
      // release the held revert reload so its post-loadImage guard runs.
      const listCountBeforeRelease = counters.list;
      revertReload.release.resolve();
      // The queue push failed, so the post-loadImage guard surfaces the warning
      // LAST (not overwritten — 'Ready.' already landed). This wait regresses to a
      // timeout if FIX 6's warning line is removed (Mutation B).
      await page.waitForFunction(() =>
        (document.querySelector('#status')?.textContent ?? '').includes(
          'durable queue push FAILED',
        ),
      );
      // The guard RETURNED — it must not have fallen through to the terminal
      // `await loadList()`. Removing the whole guard (Mutation A) would refetch
      // the list before surfacing the warning, bumping this count.
      assert.equal(counters.list, listCountBeforeRelease);
      // Sanity: the switched-to sprite is still shown (the switch really landed
      // and revert did not re-render over it).
      assert.equal(await page.locator('.sprite-title').textContent(), 'Second Fixture');
    },
    {
      revertQueueStatus: 'failed',
      imgGateByKey: { 'fixture-sprite': revertReload },
      counters,
    },
  );
});

test('save moves the clean baseline to the submitted state when Undo wins the race', async () => {
  await withEditor(
    async (page) => {
      const initialPng = await page
        .locator('.sprite-canvas')
        .evaluate((element) => element.toDataURL());
      await page.getByTitle('Erase mode').click();
      await clickCanvasPixel(page, 0, 0);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Saving…',
      );

      await page.keyboard.press('Control+z');
      await page.waitForFunction(
        () =>
          document.querySelector('#status')?.textContent ===
          'Saved submitted state; newer edits remain unsaved.',
      );
      assert.equal(
        await page.locator('.sprite-canvas').evaluate((element) => element.toDataURL()),
        initialPng,
        'Undo should leave the live canvas untouched when the save completes',
      );
      assert.equal(await page.locator('.dirty-badge').textContent(), 'Unsaved');

      const dialogMessages = [];
      page.on('dialog', async (dialog) => {
        dialogMessages.push(dialog.message());
        await dialog.dismiss();
      });
      await page.getByRole('button', { name: /Second Fixture/ }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Stayed on current sprite.',
      );
      assert.match(dialogMessages[0], /Unsaved edits detected/);
    },
    { saveDelayMs: 200 },
  );
});

test('save race baseline uses the normalized server response, not raw submitted comment text', async () => {
  await withEditor(
    async (page) => {
      await page.getByTitle('Erase mode').click();
      await page.locator('#comment').fill(' note ');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Saving…',
      );

      await clickCanvasPixel(page, 0, 0);
      await page.locator('#comment').fill('other');
      await page.locator('#comment').fill(' note ');
      await page.waitForFunction(
        () =>
          document.querySelector('#status')?.textContent ===
          'Saved submitted state; newer edits remain unsaved.',
      );

      assert.equal(await page.locator('.dirty-badge').textContent(), 'Unsaved');

      const dialogMessages = [];
      page.on('dialog', async (dialog) => {
        dialogMessages.push(dialog.message());
        await dialog.dismiss();
      });
      await page.getByRole('button', { name: /Second Fixture/ }).click();
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Stayed on current sprite.',
      );
      assert.match(dialogMessages[0], /Unsaved edits detected/);
    },
    { saveDelayMs: 200, normalizeSavedComment: true },
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
    await page.locator('#comment').fill('Keep this in-flight note');
    await setControlValue(page, '#frame', 3);
    await page.locator('#favorite-heart').click();

    await page.evaluate(() => {
      document.querySelector('[aria-label="Erase mode"]')?.click();
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
    assert.equal(await page.locator('#comment').inputValue(), 'Keep this in-flight note');
    assert.equal(await page.locator('#frame').inputValue(), '3');
    assert.equal(await page.locator('#favorite-heart').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => window.onmouseup());
  });
});

test('canvas click modes remain mutually exclusive across every arming path', async () => {
  await withEditor(async (page) => {
    await page.getByTitle('Set anchor by click').click();
    assert.equal(
      await page.getByTitle('Anchor picker active').getAttribute('aria-pressed'),
      'true',
    );

    await page.getByTitle('Pick background').click();
    assert.equal(
      await page.getByTitle('Background picker active').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      await page.getByTitle('Set anchor by click').getAttribute('aria-pressed'),
      'false',
    );

    await page.getByTitle('Eyedropper').click();
    assert.equal(await page.getByTitle('Eyedropper active').count(), 1);
    assert.equal(await page.getByTitle('Pick background').getAttribute('aria-pressed'), 'false');
    assert.equal(
      await page.getByTitle('Set anchor by click').getAttribute('aria-pressed'),
      'false',
    );

    await page.getByTitle('Pick background').click();
    await page.locator('#tool-anchor').click();
    await page.locator('.tool-panel').getByRole('button', { name: 'Set anchor by click' }).click();
    assert.equal(await page.getByTitle('Pick background').getAttribute('aria-pressed'), 'false');
    assert.equal(
      await page.getByTitle('Anchor picker active').getAttribute('aria-pressed'),
      'true',
    );
  });
});

test('mutually exclusive reactions stay scoped to the sprite being edited', async () => {
  await withEditor(async (page) => {
    const heart = page.locator('#favorite-heart');
    const dislike = page.locator('#dislike-button');
    assert.equal(await page.getByRole('textbox', { name: 'Comment / Feedback' }).count(), 1);
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

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });
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

test('numeric metadata controls have accessible names via label association', async () => {
  await withEditor(async (page) => {
    for (const name of ['Anchor X', 'Anchor Y', 'Pivot X', 'Pivot Y', 'Frame', 'Column', 'Row']) {
      assert.equal(await page.getByRole('spinbutton', { name }).count(), 1);
    }
  });
});

test('transparent corners require an explicit background sample for color cleanup', async () => {
  await withEditor(async (page) => {
    const pixels = new Array(8 * 8 * 4).fill(0);
    pixels.splice((3 * 8 + 3) * 4, 4, ...rgba(0, 0, 0));
    pixels.splice((3 * 8 + 4) * 4, 4, ...rgba(180, 40, 40));
    await paintSprite(page, 8, 8, pixels);
    const before = await readCanvasPixels(page);

    await page.locator('#tool-background').click();
    await setControlValue(page, '#background-removal-method', 'color-key');
    await setControlValue(page, '#background-removal-tolerance', 0);
    await setControlValue(page, '#background-removal-softness', 0);
    await page.locator('.tool-panel').getByRole('button', { name: 'Remove BG' }).click();
    assert.equal(
      await page.locator('#status').textContent(),
      'Pick a background color before background removal.',
    );
    assert.deepEqual(await readCanvasPixels(page), before);

    await page.locator('#tool-fringe').click();
    await page.locator('.tool-panel').getByRole('button', { name: 'Normalize fringe' }).click();
    assert.equal(
      await page.locator('#status').textContent(),
      'Pick a background color before fringe normalization.',
    );
    assert.deepEqual(await readCanvasPixels(page), before);
  });
});

test('background picking ignores fully transparent pixels', async () => {
  await withEditor(async (page) => {
    await paintSprite(page, 4, 4, new Array(4 * 4 * 4).fill(0));
    await page.getByTitle('Pick background').click();
    await clickCanvasPixel(page, 0, 0);
    assert.equal(
      await page.locator('#status').textContent(),
      'Background sample ignored: picked pixel is fully transparent.',
    );
    assert.equal(
      await page.locator('#background-picker-quick').getAttribute('aria-pressed'),
      'true',
    );

    await page.locator('#tool-background').click();
    await setControlValue(page, '#background-removal-method', 'color-key');
    await setControlValue(page, '#background-removal-tolerance', 0);
    await setControlValue(page, '#background-removal-softness', 0);
    await page.locator('.tool-panel').getByRole('button', { name: 'Remove BG' }).click();
    assert.equal(
      await page.locator('#status').textContent(),
      'Pick a background color before background removal.',
    );
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

test('fringe normalization preserves low-alpha interior details', async () => {
  await withEditor(async (page) => {
    await paintSprite(page, 3, 3, [
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(20, 80, 220, 20),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
      ...rgba(180, 40, 40),
    ]);
    const before = await readCanvasPixels(page);
    await page.locator('#tool-fringe').click();
    await setControlValue(page, '#fringe-normalize-method', 'opaque-average');
    await setControlValue(page, '#fringe-normalize-strength', 100);
    await page.locator('.tool-panel').getByRole('button', { name: 'Normalize fringe' }).click();

    const pixels = await readCanvasPixels(page);
    const centerOffset = (1 * 3 + 1) * 4;
    assert.deepEqual(
      pixels.slice(centerOffset, centerOffset + 4),
      before.slice(centerOffset, centerOffset + 4),
    );
  });
});
