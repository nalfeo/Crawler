#!/usr/bin/env node
/**
 * health/governor-playthroughs.ts — Drive the headless Governor agent across
 * each floor archetype and emit a balance metrics JSON snapshot to
 * `coverage/balance-metrics.json` for downstream consumption by
 * `balance-regression.ts`.
 *
 * The headless Governor harness is not yet wired (see issue #1 follow-ups),
 * so this script currently SKIPs cleanly. The skeleton + interface is in
 * place so wiring it later is a one-file change.
 */

import process from 'node:process';
import { existsSync } from 'node:fs';
import { Report, fromRepo } from '../shared/report.js';

const HARNESS_PATH = 'src/labs/governor-lab/headless.ts';

async function main(): Promise<void> {
  const report = new Report('health-governor-playthroughs');
  if (!existsSync(fromRepo(HARNESS_PATH))) {
    report.skip(
      `Headless Governor harness not yet present at ${HARNESS_PATH}. Tracked in follow-up issue.`,
    );
    report.finish();
  }
  // When the harness exists, dynamic import + invoke it here, then write
  // `coverage/balance-metrics.json` with whatever the harness returned.
  report.warn('Governor harness present but driver code not yet implemented.');
  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `governor-playthroughs crashed: ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(2);
});
