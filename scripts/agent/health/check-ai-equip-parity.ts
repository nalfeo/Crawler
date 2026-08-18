#!/usr/bin/env node
/**
 * health/check-ai-equip-parity.ts — Deterministic parity guard.
 *
 * The headless AI runner is the balance oracle (Rule 12 gates Floor 1 win-rate
 * on it), so anything the AI can do that a human player cannot silently
 * corrupts that measurement. The specific historical leak: AI-only call sites
 * passed `{ force: true }` to the equipment mutators, bypassing the
 * `isInSafeContext` gate that binds every human Equipment/Inventory panel
 * action. An AI that can re-gear mid-combat anywhere on the floor is not
 * measuring the game a human plays.
 *
 * This check fails when any file under `src/game/ai/**` passes `force` to an
 * equipment mutator. Scenario/bootstrap grants (the game handing the player an
 * item, which happens identically on a human run) live outside `src/game/ai/`
 * and are unaffected; the narrow allowlist below exists for AI-path exceptions
 * only and is empty by design.
 *
 * Wired into `verify` and CI. It exists because "no force in the AI path" is a
 * recurring review finding, and recurring review findings become deterministic
 * checks rather than relying on future reviewer consistency.
 */

import { Report, fromRepo } from '../shared/report.js';
import { findAiForceEquipViolations } from './ai-equip-parity-lib.js';

const report = new Report('check-ai-equip-parity');

const { violations, scannedFiles } = findAiForceEquipViolations(fromRepo('src', 'game', 'ai'));

for (const violation of violations) {
  report.error(
    `AI-only equipment privilege: \`${violation.snippet}\` forces past the safe-context gate a human player is bound by`,
    {
      file: violation.file,
      line: violation.line,
      remediation:
        'Remove the force option and defer the action until the player is in a safe context (see settlement-maintenance-planner.ts and merchant-weapon-intent.ts for the deferral patterns).',
    },
  );
}

if (report.blockingCount() === 0) {
  report.info(`OK: no forced equipment mutations in ${scannedFiles} src/game/ai file(s)`);
}
report.finish();
