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

// Confirm the lab genuinely starts paused (frame 0) BEFORE touching controls.
const beforeResume = await snap();
console.log(
  'BEFORE RESUME:',
  JSON.stringify({ frame: beforeResume?.frame, paused: beforeResume?.paused }),
);

// Now explicitly resume + set max speed, matching a real operator driving the lab.
await page.click('#ai-speed-16');
await page.click('#ai-toggle-run');

const afterClick = await snap();
console.log(
  'IMMEDIATELY AFTER RESUME CLICK:',
  JSON.stringify({ frame: afterClick?.frame, paused: afterClick?.paused }),
);

let clearedAtIter = null;
let lastFrame = -1;
let stallIters = 0;
for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(5000);
  const s = await snap();
  const frame = s?.frame ?? null;
  const brief = {
    effectiveFloor: s?.effectiveFloor,
    worldState: s?.worldState,
    frame,
    paused: s?.paused,
    reason: s?.reason,
    runOutcome: s?.runOutcome,
  };
  console.log(`t=${i * 5}s snap=${JSON.stringify(brief)}`);

  if (s?.runOutcome === 'cleared_floor' && clearedAtIter === null) {
    clearedAtIter = i;
    console.log('>>> runOutcome=cleared_floor reached — watching for Floor 2 or a stall <<<');
  }
  if (s?.effectiveFloor === 'floor2') {
    console.log('>>> REACHED FLOOR 2 — transition succeeded <<<');
    break;
  }
  if (frame === lastFrame) {
    stallIters += 1;
  } else {
    stallIters = 0;
  }
  lastFrame = frame;
  if (clearedAtIter !== null && stallIters >= 3) {
    console.log(
      `>>> FROZEN: frame stuck at ${frame} for ${stallIters * 5}s after cleared_floor <<<`,
    );
    break;
  }
}

console.log('--- console/page logs (last 30) ---');
for (const l of logs.slice(-30)) console.log(l);

await browser.close();
