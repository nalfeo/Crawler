/**
 * Authoritative Chromium readiness gate for CI.
 *
 * `playwright install-deps` is an apt operation, so it fails whenever an Ubuntu
 * mirror is unreachable - a transient, external condition that has nothing to do
 * with whether Chromium can actually run. Gating CI on it took all of main CI
 * (and therefore every deploy) down while Chromium was perfectly launchable.
 *
 * This script checks the requirement we actually have: launch Chromium, open a
 * page, and confirm JavaScript evaluates. It depends only on the local browser
 * install, never on package mirrors. If a system library really is missing,
 * Playwright's launch error names it, which is a far better diagnostic than an
 * apt timeout.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export async function verifyChromiumLaunch(chromium) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(() => 1 + 1);
    if (result !== 2) {
      throw new Error(`Chromium evaluated 1 + 1 as ${result}; expected 2.`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const { chromium } = await import('playwright');
  try {
    await verifyChromiumLaunch(chromium);
  } catch (error) {
    process.stderr.write(
      'Chromium failed to launch. If a system library is missing it is named ' +
        'in the error below; `npx playwright install-deps chromium` installs it.\n' +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Chromium launched successfully.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
