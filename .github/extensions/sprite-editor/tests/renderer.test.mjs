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

async function withEditor(run) {
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
    assert.equal(await page.locator('#comparison-before-label').textContent(), 'Last saved');

    await brushStroke(0, 1);
    await page.getByRole('button', { name: 'Undo' }).click();
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

test('mutually exclusive reactions stay scoped to the sprite being edited', async () => {
  await withEditor(async (page) => {
    const heart = page.locator('#favorite-heart');
    const dislike = page.locator('#dislike-button');
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
