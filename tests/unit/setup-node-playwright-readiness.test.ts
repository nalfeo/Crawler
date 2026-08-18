import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type FakeChromium = {
  launch: () => Promise<{
    newPage: () => Promise<{ evaluate: (fn: () => number) => Promise<number> }>;
    close: () => Promise<void>;
  }>;
};

async function loadVerifyChromiumLaunch(): Promise<(chromium: FakeChromium) => Promise<void>> {
  const module = (await import(
    pathToFileURL(path.join(repoRoot, 'scripts/agent/verify-chromium-launch.mjs')).href
  )) as { verifyChromiumLaunch: (chromium: FakeChromium) => Promise<void> };
  return module.verifyChromiumLaunch;
}
const actionYml = readFileSync(
  path.join(repoRoot, '.github/actions/setup-node/action.yml'),
  'utf8',
);

/**
 * A transient Ubuntu mirror outage made `playwright install-deps` time out,
 * which failed all of main CI and blocked every deploy (the deploy release gate
 * requires a successful CI conclusion) even though Chromium was launchable.
 * These tests keep the apt step advisory and the launch check authoritative.
 */
describe('setup-node Playwright readiness', () => {
  it('does not fail the job when the apt dependency install fails', () => {
    // The old step ended in `exit "$status"`, propagating an apt/mirror failure
    // as a job failure. Nothing in the action may re-raise that status.
    expect(actionYml).not.toContain('exit "$status"');
    expect(actionYml).toContain('install-deps chromium');
    expect(actionYml).toContain('best-effort');
  });

  it('gates on Chromium actually launching', () => {
    expect(actionYml).toContain('node scripts/agent/verify-chromium-launch.mjs');
  });

  it('still installs the browser itself, which is not mirror-dependent', () => {
    expect(actionYml).toContain('npx playwright install chromium');
  });

  it('passes when Chromium launches and evaluates JavaScript', async () => {
    const verifyChromiumLaunch = await loadVerifyChromiumLaunch();
    let closed = false;
    const chromium = {
      launch: async () => ({
        newPage: async () => ({ evaluate: async (fn: () => number) => fn() }),
        close: async () => {
          closed = true;
        },
      }),
    };
    await expect(verifyChromiumLaunch(chromium)).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it('fails, and still closes the browser, when Chromium cannot launch a page', async () => {
    const verifyChromiumLaunch = await loadVerifyChromiumLaunch();
    let closed = false;
    const chromium = {
      launch: async () => ({
        newPage: async () => {
          throw new Error('missing libnss3');
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    await expect(verifyChromiumLaunch(chromium)).rejects.toThrow('missing libnss3');
    expect(closed).toBe(true);
  });
});
