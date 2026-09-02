import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizeText(value, fallback = 'unknown') {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text || fallback;
}

export function normalizeVerdict(value, fallback = 'unknown') {
  const verdict = normalizeText(value, fallback).toLowerCase();
  if (['recommended', 'risky', 'not-recommended', 'unknown'].includes(verdict)) {
    return verdict;
  }
  return fallback;
}

export function normalizeDecision(rawDecision = {}) {
  const decision = Array.isArray(rawDecision) ? rawDecision[0] ?? {} : rawDecision ?? {};
  const verdict = normalizeVerdict(decision.verdict ?? decision.outcome ?? decision.result ?? decision.status, 'unknown');
  const action = normalizeText(decision.action ?? decision.task ?? decision.nextAction ?? decision.decision, 'noop');
  const markerState = normalizeText(
    decision.markerState ?? decision.marker ?? decision.resolutionStatus ?? decision.state,
    'unknown',
  );
  const mutates = Boolean(decision.mutates ?? decision.writes ?? decision.write === true);
  const noOp = Boolean(decision.noOp ?? decision.isNoop ?? (!mutates && action === 'noop'));

  return {
    workflowName: normalizeText(decision.workflowName ?? decision.workflow ?? 'legacy'),
    issueNumber: normalizeText(decision.issueNumber ?? decision.issue_number ?? 'n/a'),
    prNumber: normalizeText(decision.prNumber ?? decision.pr_number ?? 'n/a'),
    trigger: normalizeText(decision.trigger ?? 'unknown'),
    verdict,
    action,
    markerState,
    mutates,
    noOp,
  };
}

export function makeIdempotencyKey(input = {}) {
  const ordered = Object.keys(input)
    .sort()
    .reduce((acc, key) => {
      acc[key] = input[key];
      return acc;
    }, {});
  const payload = JSON.stringify(ordered, null, 0);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function compareLegacyAndGoobers(legacyDecision, shadowDecision) {
  const legacy = normalizeDecision(legacyDecision);
  const shadow = normalizeDecision(shadowDecision);
  const divergences = [];

  if (legacy.verdict !== shadow.verdict) {
    divergences.push(`verdict mismatch legacy=${legacy.verdict} shadow=${shadow.verdict}`);
  }
  if (legacy.action !== shadow.action) {
    divergences.push(`action mismatch legacy=${legacy.action} shadow=${shadow.action}`);
  }
  if (legacy.markerState !== shadow.markerState) {
    divergences.push(
      `marker mismatch legacy=${legacy.markerState} shadow=${shadow.markerState}`,
    );
  }
  if (legacy.mutates !== shadow.mutates) {
    divergences.push(
      `mutation mismatch legacy=${legacy.mutates} shadow=${shadow.mutates}`,
    );
  }

  return {
    parityPassed: divergences.length === 0,
    divergences,
    legacyDecision: legacy,
    shadowDecision: shadow,
    idempotencyKey: makeIdempotencyKey({
      legacy: legacy.verdict,
      shadow: shadow.verdict,
      action: legacy.action,
      markerState: legacy.markerState,
      trigger: legacy.trigger,
    }),
  };
}

export function buildShadowReport({ scope = 'ci-recovery,merge-train', reportDay = '2026-09-02', legacyDecision, shadowDecision }) {
  const comparison = compareLegacyAndGoobers(legacyDecision, shadowDecision);
  return {
    contractVersion: 'v1',
    workflowName: 'goobers-shadow',
    scope,
    reportDay,
    idempotencyKey: makeIdempotencyKey({ scope, reportDay, legacy: comparison.legacyDecision.verdict, shadow: comparison.shadowDecision.verdict }),
    parityStatus: comparison.parityPassed ? 'clean' : 'divergence',
    legacy: comparison.legacyDecision,
    shadow: comparison.shadowDecision,
    divergences: comparison.divergences,
    writesAllowed: false,
    isReadOnly: true,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    options[key] = next && !next.startsWith('--') ? next : true;
    if (next && !next.startsWith('--')) i += 1;
  }
  return options;
}

function writeReport(report, outputPath) {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const scope = normalizeText(args.scope ?? process.env.GOOBERS_SHADOW_SCOPE ?? 'ci-recovery,merge-train');
  const reportDay = normalizeText(args.reportDay ?? process.env.GOOBERS_SHADOW_REPORT_DAY ?? '2026-09-02');
  const legacyDecision = {
    workflowName: 'ci-recovery',
    prNumber: '42',
    trigger: scope,
    verdict: 'recommended',
    action: 'reconcile',
    markerState: 'resolved',
    mutates: false,
  };
  const shadowDecision = {
    workflowName: 'goobers-shadow',
    prNumber: '42',
    trigger: scope,
    verdict: 'recommended',
    action: 'reconcile',
    markerState: 'resolved',
    mutates: false,
  };
  const report = buildShadowReport({ scope, reportDay, legacyDecision, shadowDecision });
  const outputPath = normalizeText(args.output ?? process.env.GOOBERS_SHADOW_OUTPUT ?? '.goobers-shadow/report.json');
  writeReport(report, outputPath);
  console.log(JSON.stringify(report, null, 2));
}
