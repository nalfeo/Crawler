import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension.mjs');
const EXTENSION_SOURCE = readFileSync(EXTENSION_PATH, 'utf8');
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0n0AAAAASUVORK5CYII=',
  'base64',
);

function renderHtml(applyToken) {
  const startMarker = 'function renderHtml(applyToken) {';
  const start = EXTENSION_SOURCE.indexOf(startMarker);
  assert.notEqual(start, -1, 'expected renderHtml function');
  const templateMarker = 'const HTML_TEMPLATE = `';
  const templateStart = EXTENSION_SOURCE.indexOf(templateMarker, start);
  assert.notEqual(templateStart, -1, 'expected HTML template');
  const bodyStart = templateStart + templateMarker.length;
  const bodyEnd = EXTENSION_SOURCE.indexOf('`;', bodyStart);
  assert.notEqual(bodyEnd, -1, 'expected end of HTML template');
  return EXTENSION_SOURCE.slice(bodyStart, bodyEnd).replace(
    '__SET_PIECE_EDITOR_APPLY_TOKEN__',
    JSON.stringify(applyToken),
  );
}

function createPack(overrides = {}) {
  return {
    setPieces: [
      {
        id: 'sp-1',
        name: 'Fixture Room',
        theme: 'test',
        sizing: 'room',
        width: 8,
        height: 7,
        sceneLayers: [{ id: 'default', name: 'Default', visible: true, locked: false }],
        props: [],
        npcs: [],
        ...overrides,
      },
    ],
  };
}

async function withEditor(t, pack, run) {
  const applyBodies = [];
  const html = renderHtml('test-token');
  const sseClients = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pack));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/generated-index') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/sheet/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(ONE_BY_ONE_PNG);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/apply') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        applyBodies.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?setPieceId=sp-1`);
    await page.waitForFunction(() => document.getElementById('spsel').value === 'sp-1');
    await run({ page, applyBodies });
  } finally {
    await browser?.close();
    for (const client of sseClients) client.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function canvasPoint(page, tileX, tileY) {
  const box = await page.locator('#gc').boundingBox();
  assert.ok(box, 'expected canvas bounding box');
  return {
    x: box.x + tileX * 48,
    y: box.y + tileY * 48,
  };
}

test('production globals clamp negative NPC depth above terrain', async (t) => {
  await withEditor(t, createPack(), async ({ page }) => {
    const { depth, expected } = await page.evaluate(() => ({
      depth: globalZ('default', 'npc', -10),
      expected: TERRAIN_DEPTH + NPC_TERRAIN_MARGIN,
    }));
    assert.equal(depth, expected);
  });
});

test('production globals expose custom sprite native tile dimensions', async (t) => {
  await withEditor(t, createPack(), async ({ page }) => {
    const dims = await page.evaluate(() =>
      getNativeSpriteTileDimensions({ source: 'custom', widthTiles: 2, heightTiles: 3 }),
    );
    assert.deepEqual(dims, { w: 2, h: 3 });
    const fallback = await page.evaluate(() =>
      getNativeSpriteTileDimensions({ source: 'catalog', spriteId: 'sprite:item.gem' }),
    );
    assert.deepEqual(fallback, { w: 1, h: 1 });
  });
});

test('hover tooltip reports the real default NPC depth', async (t) => {
  const pack = createPack({
    npcs: [{ id: 'npc-a', npcTypeId: 'tutorial-goon', x: 1, y: 1, widthFt: 4, heightFt: 4 }],
  });
  await withEditor(t, pack, async ({ page }) => {
    const point = await canvasPoint(page, 1.5, 1.5);
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => document.getElementById('tooltip').style.display === 'block');
    const tooltip = await page.locator('#tooltip').textContent();
    assert.match(tooltip, /🧍 NPC: npc-a/);
    assert.match(tooltip, /type: tutorial-goon/);
    assert.match(tooltip, /pos: 1, 1/);
    assert.match(tooltip, /size: 1\.00×1\.00 tiles/);
    assert.match(tooltip, /layer: Default/);
    assert.match(tooltip, /z: auto \(0 entity depth\)/);
  });
});

test('negative-z NPCs stay above deeper negative props in production hit testing', async (t) => {
  const pack = createPack({
    props: [{ id: 'backdrop', kind: 'floor', x: 1, y: 1, width: 1, height: 1, z: -10, layers: [] }],
    npcs: [
      { id: 'npc-a', npcTypeId: 'tutorial-goon', x: 1, y: 1, z: -10, widthFt: 4, heightFt: 4 },
    ],
  });
  await withEditor(t, pack, async ({ page }) => {
    const point = await canvasPoint(page, 1.5, 1.5);
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => document.getElementById('tooltip').style.display === 'block');
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => document.getElementById('nid').value === 'npc-a');
  });
});

test('dragging and applying use the production editor state machine', async (t) => {
  const pack = createPack({
    npcs: [{ id: 'npc-a', npcTypeId: 'tutorial-goon', x: 1, y: 1, widthFt: 4, heightFt: 4 }],
  });
  await withEditor(t, pack, async ({ page, applyBodies }) => {
    const start = await canvasPoint(page, 1.5, 1.5);
    const dragged = await canvasPoint(page, 2.6, 2.6);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(dragged.x, dragged.y);
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('nxf').value === '2.5');
    await page.waitForFunction(() => document.getElementById('nyf').value === '2.5');

    await page.click('#btnapply');
    await page.waitForFunction(() => document.getElementById('stbar').textContent === 'Ready');
    assert.equal(applyBodies.length, 1);
    assert.deepEqual(applyBodies[0].npcs, [
      {
        id: 'npc-a',
        npcTypeId: 'tutorial-goon',
        x: 2.5,
        y: 2.5,
        widthFt: 4,
        heightFt: 4,
      },
    ]);
  });
});

test('resizing uses the production editor state machine', async (t) => {
  const pack = createPack({
    npcs: [{ id: 'npc-a', npcTypeId: 'tutorial-goon', x: 1, y: 1, widthFt: 4, heightFt: 4 }],
  });
  await withEditor(t, pack, async ({ page }) => {
    const point = await canvasPoint(page, 1.5, 1.5);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => document.getElementById('nid').value === 'npc-a');

    const handle = await canvasPoint(page, 2, 2);
    const bigger = await canvasPoint(page, 3, 3);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(bigger.x, bigger.y);
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('nwf').value === '8');
    await page.waitForFunction(() => document.getElementById('nhf').value === '8');
    assert.equal(await page.locator('#nxf').inputValue(), '1');
    assert.equal(await page.locator('#nyf').inputValue(), '1');
  });
});

test('undo and redo restore and reapply NPC drag state before apply payload', async (t) => {
  const pack = createPack({
    npcs: [{ id: 'npc-a', npcTypeId: 'tutorial-goon', x: 1, y: 1, widthFt: 4, heightFt: 4 }],
  });
  await withEditor(t, pack, async ({ page, applyBodies }) => {
    const start = await canvasPoint(page, 1.5, 1.5);
    const dragged = await canvasPoint(page, 2.6, 2.6);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(dragged.x, dragged.y);
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('nxf').value === '2.5');
    await page.waitForFunction(() => document.getElementById('nyf').value === '2.5');

    await page.click('#btnundo');
    await page.waitForFunction(() => document.getElementById('nxf').value === '1');
    await page.waitForFunction(() => document.getElementById('nyf').value === '1');

    await page.click('#btnredo');
    await page.waitForFunction(() => document.getElementById('nxf').value === '2.5');
    await page.waitForFunction(() => document.getElementById('nyf').value === '2.5');

    await page.click('#btnapply');
    await page.waitForFunction(() => document.getElementById('stbar').textContent === 'Ready');
    assert.equal(applyBodies.length, 1);
    assert.equal(applyBodies[0].npcs[0].x, 2.5);
    assert.equal(applyBodies[0].npcs[0].y, 2.5);
  });
});

test('snap size rounds per mode in production globals', async (t) => {
  await withEditor(t, createPack(), async ({ page }) => {
    const snap = await page.evaluate(() => {
      const prev = S.snapMode;
      S.snapMode = 'tile';
      const tile = snapSz(1.26);
      S.snapMode = 'half';
      const half = snapSz(1.26);
      S.snapMode = 'quarter';
      const quarter = snapSz(1.26);
      S.snapMode = 'free';
      const free = snapSz(1.26);
      S.snapMode = prev;
      return { tile, half, quarter, free };
    });
    assert.deepEqual(snap, { tile: 1, half: 1.5, quarter: 1.25, free: 1.26 });
  });
});
