import { chromium } from 'playwright';

const url = 'http://localhost:5299/lab.html?lab=ai-runner';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.stack || err.message}`));

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('#ai-playback-dock', { timeout: 45000 });

const snap = async () =>
  page.evaluate(() => (window.__aiRunnerDebug ? window.__aiRunnerDebug() : null));

await page.click('#ai-speed-16');
await page.click('#ai-toggle-run');

let clearedAtIter = null;
let lastFrame = -1;
let stallIters = 0;
let outcome = 'timeout';
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(5000);
  const s = await snap();
  const frame = s?.frame ?? null;
  if (s?.runOutcome === 'cleared_floor' && clearedAtIter === null) {
    clearedAtIter = i;
  }
  if (s?.effectiveFloor === 'floor2') {
    outcome = 'REACHED_FLOOR2';
    break;
  }
  if (frame === lastFrame) {
    stallIters += 1;
  } else {
    stallIters = 0;
  }
  lastFrame = frame;
  if (clearedAtIter !== null && stallIters >= 3) {
    outcome = `FROZEN at frame ${frame}`;
    break;
  }
}

console.log('OUTCOME:', outcome);
const hasErr = logs.some((l) => l.includes('pageerror'));
console.log('HAD_PAGEERROR:', hasErr);
if (hasErr) {
  console.log(logs.find((l) => l.includes('pageerror')));
}
await browser.close();
