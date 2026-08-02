import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/uxcap/before';
// iPhone 13 Pro landscape: 2532×1170 physical @ DPR 3 = 844×390 CSS px.
const VIEWPORT = { width: 844, height: 390 };
// Real iPhone 13 Pro landscape safe-area insets (notch side + home indicator).
const INSETS = { top: 0, right: 47, bottom: 21, left: 47 };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3 });
const page = await context.newPage();
const url = 'http://localhost:5299/lab.html?lab=main-scene-probe-lab';
await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
await page.waitForFunction(() => Boolean(window.__mainSceneProbe?.ready()), undefined, {
  timeout: 60000,
  polling: 200,
});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  document.getElementById('app-header')?.style.setProperty('display', 'none');
  document.getElementById('lab-controls')?.style.setProperty('display', 'none');
  document.getElementById('controls-toggle')?.style.setProperty('display', 'none');
  window.dispatchEvent(new Event('resize'));
});
await page.waitForTimeout(800);

if (process.env.RESOLVE_LOADOUT === '1') {
  await page.evaluate(() => window.__mainSceneProbe.resolveLoadout());
  await page.waitForTimeout(1200);
}

// Overlay the real iPhone safe-area bands so the capture shows what the notch
// and home indicator physically cover.
await page.addStyleTag({
  content: `
  #safe-overlay{position:fixed;inset:0;pointer-events:none;z-index:99999}
  #safe-overlay div{position:absolute;background:rgba(255,0,0,.35)}
  `,
});
await page.evaluate((ins) => {
  const o = document.createElement('div');
  o.id = 'safe-overlay';
  const mk = (css) => {
    const d = document.createElement('div');
    d.style.cssText = css;
    o.appendChild(d);
  };
  if (ins.left) mk(`left:0;top:0;bottom:0;width:${ins.left}px`);
  if (ins.right) mk(`right:0;top:0;bottom:0;width:${ins.right}px`);
  if (ins.top) mk(`left:0;right:0;top:0;height:${ins.top}px`);
  if (ins.bottom) mk(`left:0;right:0;bottom:0;height:${ins.bottom}px`);
  document.body.appendChild(o);
}, INSETS);

const info = await page.evaluate(() => {
  const canvas = document.querySelector('#lab-canvas canvas');
  const r = canvas.getBoundingClientRect();
  return {
    canvas: { x: r.x, y: r.y, width: r.width, height: r.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
  };
});
console.log(JSON.stringify({ info, insets: INSETS }, null, 2));
await page.screenshot({ path: `${OUT}.png` });
await browser.close();
