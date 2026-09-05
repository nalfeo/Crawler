import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { LIFECYCLE_PR_LANES } from './lifecycle-ownership.mjs';

/**
 * Phase 4 of the Goobers migration (epic #3838, issue #3839): decommission the
 * legacy CI-recovery/merge-train lifecycle mutation paths.
 *
 * Removal is deliberately NOT a judgement call made in prose. Every legacy lane
 * that is deleted must first have a Goobers writer, a completed soak window
 * with zero rollback activations, and a passing rollback drill. This module is
 * the deterministic gate for that: it decides readiness from a committed
 * evidence record, and it scans the workflow surface for the two failure modes
 * that would actually hurt — an *ungated* legacy mutation path (dual writer),
 * and a legacy mutation path deleted while its lane is still legacy-owned
 * (zero writers, PR automation dark).
 *
 * Both directions fail closed: missing, malformed, or unattested evidence
 * reports "not ready", never "ready".
 */

export const DEFAULT_SOAK_DAYS = 14;
export const DEFAULT_STATE_PATH = '.github/lifecycle/decommission-state.json';
const DAY_MS = 86_400_000;

/**
 * The legacy lifecycle mutation surface, keyed by workflow file.
 *
 * `entrypoints` are the literal strings that mark a step as performing a legacy
 * lifecycle mutation. They are matched against the step's `run` script and any
 * `actions/github-script` body, so a mutation cannot be smuggled in by renaming
 * the step.
 */
export const LEGACY_MUTATION_SURFACE = Object.freeze([
  Object.freeze({
    workflow: 'ci-recovery.yml',
    lane: 'ci-recovery',
    selector: 'LIFECYCLE_OWNER_CI_RECOVERY',
    entrypoints: Object.freeze(['.github/scripts/ci-recovery/reconcile.mjs']),
  }),
  Object.freeze({
    workflow: 'ci-recovery-router.yml',
    lane: 'ci-recovery',
    selector: 'LIFECYCLE_OWNER_CI_RECOVERY',
    entrypoints: Object.freeze(['.github/scripts/ci-recovery/router.mjs']),
  }),
  Object.freeze({
    workflow: 'merge-train.yml',
    lane: 'merge-train',
    selector: 'LIFECYCLE_OWNER_MERGE_TRAIN',
    entrypoints: Object.freeze([
      '.github/scripts/merge-train/reconcile.mjs',
      '.github/scripts/merge-train/quarantine-repair.mjs',
    ]),
  }),
  Object.freeze({
    workflow: 'auto-rebase-prs.yml',
    lane: 'branch-update',
    selector: 'LIFECYCLE_OWNER_BRANCH_UPDATE',
    entrypoints: Object.freeze(['/update-branch']),
  }),
]);

/** The gate every legacy mutation step must carry, for its own lane. */
export function legacyLaneGateExpression(selector) {
  return `vars.${selector} != 'goobers' && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'`;
}

function isIsoInstant(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function laneOwnersFrom(state) {
  const lanes = state?.lanes;
  return lanes && typeof lanes === 'object' && !Array.isArray(lanes) ? lanes : {};
}

/**
 * Decide whether the legacy lifecycle mutation paths may be decommissioned.
 *
 * Returns every blocker rather than the first one, so an operator sees the full
 * remaining distance in a single run instead of discovering it one soak window
 * at a time.
 */
export function decideLegacyDecommission({ state, now, soakDays = DEFAULT_SOAK_DAYS } = {}) {
  const blockers = [];
  const requiredDays = Number.isInteger(soakDays) && soakDays > 0 ? soakDays : DEFAULT_SOAK_DAYS;
  const nowMs = Date.parse(String(now ?? ''));

  if (!state || typeof state !== 'object' || Array.isArray(state) || !Number.isFinite(nowMs)) {
    return {
      ready: false,
      blockers: ['invalid-state'],
      soak: { startedAt: null, requiredDays, elapsedDays: null },
    };
  }

  const laneOwners = laneOwnersFrom(state);
  for (const lane of LIFECYCLE_PR_LANES) {
    // Only the literal `goobers` counts, mirroring lifecycleLaneOwner: an
    // unset, misspelled, or padded selector means the lane is still legacy.
    if (laneOwners[lane] !== 'goobers') blockers.push(`lane-not-migrated:${lane}`);
  }

  const bridge = state.emergencyBridge;
  if (!bridge || typeof bridge !== 'object' || bridge.retained !== true) {
    blockers.push('emergency-bridge-not-retained');
  } else if (!isIsoInstant(bridge.boundedUntil)) {
    // "Retained for a bounded period" is only meaningful with a declared end.
    blockers.push('emergency-bridge-window-undeclared');
  } else if (Date.parse(bridge.boundedUntil) <= nowMs) {
    blockers.push('emergency-bridge-window-expired');
  }

  const soakStartedAt = state.soak?.startedAt ?? null;
  let elapsedDays = null;
  if (!isIsoInstant(soakStartedAt)) {
    blockers.push('soak-not-started');
  } else {
    elapsedDays = (nowMs - Date.parse(soakStartedAt)) / DAY_MS;
    if (elapsedDays < requiredDays) blockers.push('soak-incomplete');
  }

  const activations = Array.isArray(state.rollbackActivations) ? state.rollbackActivations : [];
  for (const activation of activations) {
    const at = activation?.at;
    // An activation before the soak started belongs to an earlier window and
    // does not invalidate this one; anything unparseable fails closed.
    if (!isIsoInstant(at)) {
      blockers.push('rollback-activation:unparseable');
    } else if (!isIsoInstant(soakStartedAt) || Date.parse(at) >= Date.parse(soakStartedAt)) {
      blockers.push(`rollback-activation:${at}`);
    }
  }

  const drill = state.rollbackDrill;
  if (!drill || typeof drill !== 'object' || Array.isArray(drill)) {
    blockers.push('rollback-drill-missing');
  } else if (drill.result !== 'pass') {
    blockers.push('rollback-drill-not-passing');
  } else if (!isIsoInstant(drill.completedAt)) {
    blockers.push('rollback-drill-missing');
  } else if (
    isIsoInstant(soakStartedAt) &&
    Date.parse(drill.completedAt) < Date.parse(soakStartedAt)
  ) {
    // A drill run against the pre-soak configuration proves nothing about the
    // configuration being decommissioned.
    blockers.push('rollback-drill-predates-soak');
  } else if (!Array.isArray(drill.runIds) || drill.runIds.length === 0) {
    blockers.push('rollback-drill-unevidenced');
  }

  const protection = state.branchProtection;
  if (
    !protection ||
    typeof protection !== 'object' ||
    protection.updatedToGoobersContexts !== true ||
    !Array.isArray(protection.requiredChecks) ||
    protection.requiredChecks.length === 0
  ) {
    blockers.push('branch-protection-not-updated');
  }

  return {
    ready: blockers.length === 0,
    blockers,
    soak: {
      startedAt: isIsoInstant(soakStartedAt) ? soakStartedAt : null,
      requiredDays,
      elapsedDays,
    },
  };
}

function stepMutationText(step) {
  if (!step || typeof step !== 'object') return '';
  const script = step.with && typeof step.with === 'object' ? step.with.script : undefined;
  return [step.run, script].filter((value) => typeof value === 'string').join('\n');
}

function effectiveGate(job, step) {
  return [job?.if, step?.if].filter((value) => typeof value === 'string').join(' && ');
}

function normalizeGate(value) {
  return String(value ?? '').replace(/\s+/g, ' ');
}

/**
 * Scan the legacy mutation surface for the two states that are never safe:
 *
 * - `ungated-legacy-mutation`: a legacy mutation step that is not gated on its
 *   own lane selector plus the emergency bridge flag. That is a dual writer the
 *   moment the lane migrates.
 * - `decommissioned-without-migration`: the legacy mutation path is gone (step
 *   or whole workflow) while the committed record still shows the lane as
 *   legacy-owned. That leaves the lane with zero writers.
 *
 * `workflows` maps workflow file name to raw YAML text; a name absent from the
 * map is treated as a deleted workflow.
 */
export function evaluateLegacyMutationSurface({ workflows, state } = {}) {
  const laneOwners = laneOwnersFrom(state);
  const files = workflows && typeof workflows === 'object' ? workflows : {};
  const findings = [];
  const entries = [];

  for (const surface of LEGACY_MUTATION_SURFACE) {
    const text = files[surface.workflow];
    const entry = {
      workflow: surface.workflow,
      lane: surface.lane,
      selector: surface.selector,
      present: typeof text === 'string',
      mutationSteps: 0,
    };

    if (typeof text === 'string') {
      let document;
      try {
        document = parseYaml(text);
      } catch (error) {
        findings.push({
          kind: 'unparseable-workflow',
          workflow: surface.workflow,
          lane: surface.lane,
          detail: error instanceof Error ? error.message : String(error),
        });
        entries.push(entry);
        continue;
      }
      const jobs = document?.jobs && typeof document.jobs === 'object' ? document.jobs : {};
      const gate = legacyLaneGateExpression(surface.selector);
      for (const [jobName, job] of Object.entries(jobs)) {
        for (const step of Array.isArray(job?.steps) ? job.steps : []) {
          const body = stepMutationText(step);
          if (!surface.entrypoints.some((entrypoint) => body.includes(entrypoint))) continue;
          entry.mutationSteps += 1;
          if (!normalizeGate(effectiveGate(job, step)).includes(gate)) {
            findings.push({
              kind: 'ungated-legacy-mutation',
              workflow: surface.workflow,
              lane: surface.lane,
              job: jobName,
              step: typeof step?.name === 'string' ? step.name : '(unnamed)',
              detail: `must be gated on \`${gate}\``,
            });
          }
        }
      }
    }

    entry.decommissioned = entry.mutationSteps === 0;
    if (entry.decommissioned && laneOwners[surface.lane] !== 'goobers') {
      findings.push({
        kind: 'decommissioned-without-migration',
        workflow: surface.workflow,
        lane: surface.lane,
        detail: `lane is still legacy-owned in ${DEFAULT_STATE_PATH}; removing this path leaves it with no writer`,
      });
    }
    entries.push(entry);
  }

  return { ok: findings.length === 0, entries, findings };
}

function readWorkflows(directory) {
  const workflows = {};
  for (const surface of LEGACY_MUTATION_SURFACE) {
    const file = path.join(directory, surface.workflow);
    if (fs.existsSync(file)) workflows[surface.workflow] = fs.readFileSync(file, 'utf8');
  }
  return workflows;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    options[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const statePath = path.resolve(repoRoot, String(args.state || DEFAULT_STATE_PATH));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const surface = evaluateLegacyMutationSurface({
    workflows: readWorkflows(path.join(repoRoot, '.github/workflows')),
    state,
  });
  const decision = decideLegacyDecommission({
    state,
    now: typeof args.now === 'string' ? args.now : new Date().toISOString(),
    soakDays: typeof args['soak-days'] === 'string' ? Number(args['soak-days']) : undefined,
  });
  process.stdout.write(`${JSON.stringify({ decision, surface }, null, 2)}\n`);

  if (!surface.ok) {
    for (const finding of surface.findings) {
      process.stderr.write(`::error::${finding.kind} in ${finding.workflow}: ${finding.detail}\n`);
    }
    process.exit(2);
  }
  if (args['require-ready'] && !decision.ready) {
    process.stderr.write(
      `::error::legacy decommission is not ready: ${decision.blockers.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    decision.ready
      ? 'Legacy lifecycle mutation paths are cleared for decommission.\n'
      : `Legacy lifecycle mutation paths must stay: ${decision.blockers.join(', ')}\n`,
  );
}
