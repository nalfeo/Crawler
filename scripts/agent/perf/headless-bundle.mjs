#!/usr/bin/env node
/**
 * Backwards-compatible `ai:headless` launcher.
 *
 * The reusable implementation is in `prebundle-cli.mjs`; keeping this stable
 * path preserves direct invocations and existing documentation.
 */
import { launch } from './prebundle-cli.mjs';
import { fileURLToPath } from 'node:url';

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await launch(process.argv.slice(2), 'headless');
}
