import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const DEV_PORT = 4173;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}/`;

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

async function measureViteStartup(): Promise<{ viteReadyMs: number; firstFrameMs: number }> {
  const started = performance.now();
  const child = spawn(
    'bash',
    ['-lc', `cd "${repoRoot}" && npx vite --host 127.0.0.1 --port ${DEV_PORT} --strictPort`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  let resolved = false;
  const readyPromise = new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (!resolved && (text.includes('Local:') || text.includes('ready in'))) {
        resolved = true;
        resolve(performance.now() - started);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!resolved) reject(new Error(`vite dev exited before ready (code=${code ?? 'unknown'})`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('Timed out waiting for Vite dev startup'));
    }, 60_000);
  });

  let browser;
  try {
    const viteReadyMs = await readyPromise;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(DEV_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 60_000 });
    const firstFrameMs = await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return performance.now();
    });
    await browser.close();
    return { viteReadyMs, firstFrameMs };
  } finally {
    if (browser) {
      await browser.close();
    }
    child.kill('SIGTERM');
  }
}

function printResults(results: ScenarioResult[]): void {
  const lines = [
    '',
    'Scenario | build(ms) | verify:fast(ms) | vite ready(ms) | first frame(ms)',
    '--- | ---: | ---: | ---: | ---:',
  ];
  for (const row of results) {
    lines.push(
      `${row.scenario} | ${Math.round(row.buildMs)} | ${Math.round(row.verifyFastMs)} | ${Math.round(row.viteReadyMs)} | ${Math.round(row.firstFrameMs)}`,
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
  const startup = await measureViteStartup();
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
