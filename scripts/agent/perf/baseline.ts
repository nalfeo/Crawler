import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

interface TimedResult {
  label: string;
  ms: number;
}

interface ScenarioResult {
  scenario: 'cold' | 'warm';
  buildMs: number;
  verifyFastMs: number;
  viteReadyMs: number;
  firstFrameMs: number;
}

async function runShell(command: string, label: string): Promise<TimedResult> {
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-lc', `cd "${repoRoot}" && ${command}`], {
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}`));
    });
  });
  return { label, ms: performance.now() - started };
}

async function clearCaches(): Promise<void> {
  await runShell(
    'rm -rf .vitest-cache .tsbuildinfo .tsbuildinfo-src node_modules/.vite .cache/eslint',
    'cache-clear',
  );
}

async function measureViteStartup(
  port: number,
): Promise<{ viteReadyMs: number; firstFrameMs: number }> {
  const devUrl = `http://127.0.0.1:${port}/`;
  const started = performance.now();
  const child = spawn(
    'bash',
    ['-lc', `cd "${repoRoot}" && exec npx vite --host 127.0.0.1 --port ${port} --strictPort`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  let resolved = false;
  const readyPromise = new Promise<number>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    const finish = (value: number): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (!resolved && (text.includes('Local:') || text.includes('ready in'))) {
        resolved = true;
        finish(performance.now() - started);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!resolved) reject(new Error(`vite dev exited before ready (code=${code ?? 'unknown'})`));
    });
    timeoutId = setTimeout(() => {
      if (!resolved) reject(new Error('Timed out waiting for Vite dev startup'));
    }, 60_000);
    timeoutId.unref();
  });

  let browser;
  try {
    const viteReadyMs = await readyPromise;
    let firstFrameMs = Number.NaN;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(devUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('canvas', { timeout: 60_000 });
      firstFrameMs = await page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return performance.now();
      });
      await browser.close();
    } catch (error) {
      console.warn(
        `[perf:baseline] Skipping first-frame measurement: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { viteReadyMs, firstFrameMs };
  } finally {
    if (browser) {
      await browser.close();
    }
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(() => resolve(), 2_000);
    });
  }
}

function printResults(results: ScenarioResult[]): void {
  const lines = [
    '',
    'Scenario | build(ms) | verify:fast(ms) | vite ready(ms) | first frame(ms)',
    '--- | ---: | ---: | ---: | ---:',
  ];
  for (const row of results) {
    const firstFrameCell = Number.isFinite(row.firstFrameMs) ? Math.round(row.firstFrameMs) : 'n/a';
    lines.push(
      `${row.scenario} | ${Math.round(row.buildMs)} | ${Math.round(row.verifyFastMs)} | ${Math.round(row.viteReadyMs)} | ${firstFrameCell}`,
    );
  }
  console.log(lines.join('\n'));
}

async function measureScenario(scenario: 'cold' | 'warm'): Promise<ScenarioResult> {
  if (scenario === 'cold') {
    await clearCaches();
  }
  const build = await runShell('npm run build', 'build');
  if (scenario === 'cold') {
    await clearCaches();
  }
  const verifyFast = await runShell('npm run verify:fast', 'verify:fast');
  if (scenario === 'cold') {
    await clearCaches();
  }
  const startup = await measureViteStartup(scenario === 'cold' ? 4173 : 4174);
  return {
    scenario,
    buildMs: build.ms,
    verifyFastMs: verifyFast.ms,
    viteReadyMs: startup.viteReadyMs,
    firstFrameMs: startup.firstFrameMs,
  };
}

async function main(): Promise<void> {
  await mkdir(path.join(repoRoot, '.cache'), { recursive: true });
  const cold = await measureScenario('cold');
  const warm = await measureScenario('warm');
  printResults([cold, warm]);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
