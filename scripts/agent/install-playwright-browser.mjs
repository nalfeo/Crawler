#!/usr/bin/env node
/**
 * Root `postinstall` browser provisioning.
 *
 * `playwright install chromium` is an explicit CLI invocation, and Playwright
 * only honours `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` inside its own postinstall
 * hook — not in the CLI command. Since CI runs `npm ci` on every job, an
 * ungated postinstall downloads ~290 MB of Chromium/FFmpeg for jobs that never
 * launch a browser. This wrapper makes the environment variable authoritative
 * for our postinstall too; jobs that need a browser install it explicitly.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function shouldSkipBrowserDownload(env = process.env) {
  const value = String(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? '').trim();
  return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function main() {
  if (shouldSkipBrowserDownload()) {
    process.stdout.write(
      'Skipping Chromium download because PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set.\n',
    );
    return;
  }

  const result = spawnSync('playwright', ['install', 'chromium'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
