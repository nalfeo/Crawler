import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/scripts/goobers-shadow.mjs',
);
const captureModulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/scripts/capture-legacy-lifecycle.mjs',
);
const {
  buildShadowReport,
  emitGoobersShadowDecisions,
  legacyMarkerState,
  makeIdempotencyKey,
  parseMarkerState,
  shadowMarkerState,
} = await import(modulePath);
const { parseCiRecoveryDecision } = await import(captureModulePath);

const resolvedThread = {
  isResolved: true,
  comments: {
    nodes: [
      {
        body: '✅ Addressed in abc1234: fixed the lifecycle gate',
        author: { login: 'nalfeo' },
        authorAssociation: 'OWNER',
      },
    ],
  },
};
const unresolvedThread = {
  isResolved: false,
  comments: {
    nodes: [
      {
        body: 'still investigating',
        author: { login: 'nalfeo' },
        authorAssociation: 'OWNER',
      },
    ],
  },
};

function withLegacyDecision(trigger: Record<string, unknown>, action: string) {
  const reviewThreads = (trigger.reviewThreads as Array<{ isResolved: boolean }>) ?? [];
  return {
    ...trigger,
    legacyDecision: {
      workflowName: trigger.workflowName,
      prNumber: trigger.prNumber,
      trigger: trigger.trigger,
      verdict:
        Number(
          (trigger.lifecycle as { decision?: { blockerCount?: number } }).decision?.blockerCount ??
            0,
        ) > 0 ||
        action === 'blocked' ||
        action === 'failure'
          ? 'risky'
          : 'recommended',
      action,
      markerState:
        reviewThreads.length === 0
          ? 'none'
          : reviewThreads.every((thread) => thread.isResolved)
            ? 'resolved'
            : 'unresolved',
      mutates: false,
      noOp: true,
    },
  };
}

function buildReport(options: {
  scope: string;
  reportDay: string;
  triggers: Array<{ trigger: Record<string, unknown>; legacyAction: string }>;
}) {
  const triggers = options.triggers.map(({ trigger, legacyAction }) =>
    withLegacyDecision(trigger, legacyAction),
  );
  return buildShadowReport({
    ...options,
    triggers,
    shadowDecisions: emitGoobersShadowDecisions(triggers),
  });
}

describe('Goobers shadow-mode parity', () => {
  it('keeps duplicate replays idempotent', () => {
    const input = { scope: 'ci-recovery', reportDay: '2026-09-02', run: '77' };
    expect(makeIdempotencyKey(input)).toBe(
      makeIdempotencyKey({ reportDay: '2026-09-02', run: '77', scope: 'ci-recovery' }),
    );
  });

  it('uses the final immutable CI Recovery decision record from a legacy run', () => {
    const log = [
      'CI_RECOVERY_DECISION {"pr":41,"row":"R26","action":"wait-admission"}',
      'other output',
      'CI_RECOVERY_DECISION {"pr":41,"row":"DISPATCH","action":"dispatch-copilot"}',
    ].join('\n');

    expect(parseCiRecoveryDecision(log)).toEqual({
      pr: 41,
      row: 'DISPATCH',
      action: 'dispatch-copilot',
    });
    expect(parseCiRecoveryDecision('skip draft pr=#41')).toBeNull();
  });

  it('replays representative CI Recovery and Merge Train outcomes from captured runs', () => {
    const report = buildReport({
      scope: 'ci-recovery,merge-train',
      reportDay: '2026-09-02',
      triggers: [
        {
          legacyAction: 'pending',
          trigger: {
            workflowName: 'merge-train',
            runId: '22',
            prNumber: '42',
            trigger: 'schedule',
            lifecycle: { kind: 'merge-train', state: 'pending' },
            headSha: 'abc1234'.padEnd(40, '0'),
            reviewThreads: [resolvedThread],
          },
        },
        {
          legacyAction: 'dispatch-copilot',
          trigger: {
            workflowName: 'ci-recovery',
            runId: '11',
            prNumber: '41',
            trigger: 'workflow_dispatch',
            lifecycle: {
              kind: 'ci-recovery',
              decision: { row: 'DISPATCH', blockerCount: 1 },
            },
            headSha: 'abc1234'.padEnd(40, '0'),
            reviewThreads: [unresolvedThread],
          },
        },
      ],
    });

    expect(report.parityStatus).toBe('clean');
    expect(report.representativeCoverage).toEqual({
      requestedWorkflows: ['ci-recovery', 'merge-train'],
      coveredWorkflows: ['ci-recovery', 'merge-train'],
      missingCoverage: [],
    });
    expect(
      report.decisions.map((decision: { sourceRunId: string }) => decision.sourceRunId),
    ).toEqual(['11', '22']);
    expect(report.writesAllowed).toBe(false);
  });

  it('rejects malformed or quoted resolution markers without false resolved state', () => {
    expect(parseMarkerState('> ✅ Addressed in abc1234: quoted evidence')).toBe('unresolved');
    expect(parseMarkerState('✅ Addressed in not-a-sha: invalid')).toBe('unresolved');
    expect(parseMarkerState('✅ Not applicable: deterministic reason')).toBe('resolved');
    expect(parseMarkerState('Addressed in ``abc1234``.')).toBe('resolved');
    expect(parseMarkerState('✅ Addressed in abc1234/def5678)')).toBe('resolved');
    expect(legacyMarkerState([{ isResolved: true, comments: { nodes: [] } }])).toBe('resolved');
    expect(
      shadowMarkerState([
        { isResolved: false, comments: { nodes: [{ body: '> ✅ Addressed in abc1234: quoted' }] } },
      ]),
    ).toBe('unresolved');

    const report = buildReport({
      scope: 'ci-recovery',
      reportDay: '2026-09-02',
      triggers: [
        {
          legacyAction: 'dispatch-copilot',
          trigger: {
            workflowName: 'ci-recovery',
            runId: '11',
            prNumber: '41',
            trigger: 'workflow_dispatch',
            lifecycle: {
              kind: 'ci-recovery',
              decision: { row: 'DISPATCH', blockerCount: 1 },
            },
            headSha: 'abc1234'.padEnd(40, '0'),
            reviewThreads: [
              {
                isResolved: false,
                comments: { nodes: [{ body: '> ✅ Addressed in abc1234: quoted' }] },
              },
            ],
          },
        },
      ],
    });

    expect(report.parityStatus).toBe('clean');
    expect(report.divergences).toEqual([]);
  });

  it('fails closed when a requested legacy workflow has no captured runs', () => {
    const report = buildReport({
      scope: 'ci-recovery,merge-train',
      reportDay: '2026-09-02',
      triggers: [
        {
          legacyAction: 'arm-auto-merge',
          trigger: {
            workflowName: 'ci-recovery',
            runId: '11',
            prNumber: '41',
            trigger: 'workflow_dispatch',
            lifecycle: { kind: 'ci-recovery', decision: { row: 'R28', blockerCount: 0 } },
            reviewThreads: [],
          },
        },
      ],
    });

    expect(report.parityStatus).toBe('divergence');
    expect(report.divergences).toContain('missing representative coverage for merge-train');
  });

  it('detects an independently produced Goobers action divergence', () => {
    const trigger = withLegacyDecision(
      {
        workflowName: 'ci-recovery',
        runId: '11',
        prNumber: '41',
        trigger: 'workflow_dispatch',
        lifecycle: {
          kind: 'ci-recovery',
          decision: { row: 'R26', blockerCount: 0 },
        },
        reviewThreads: [],
      },
      'wait-admission',
    );
    const report = buildShadowReport({
      scope: 'ci-recovery',
      reportDay: '2026-09-02',
      triggers: [trigger],
      shadowDecisions: [
        {
          sourceRunId: '11',
          prNumber: '41',
          shadowDecision: { ...trigger.legacyDecision, action: 'dispatch-copilot' },
        },
      ],
    });

    expect(report.parityStatus).toBe('divergence');
    expect(report.divergences).toContain(
      'run=11 action mismatch legacy=wait-admission shadow=dispatch-copilot',
    );
  });

  it('keeps daily collection bounded and divergence artifacts unconditional', () => {
    const workflow = fs.readFileSync(
      path.resolve(path.dirname(modulePath), '../workflows/goobers-shadow.yml'),
      'utf8',
    );

    expect(workflow).toContain('currentRun.created_at.slice(0, 10)');
    expect(workflow).toContain('created,');
    expect(workflow).toContain('listWorkflowRunArtifacts');
    expect(workflow).toContain('legacy-lifecycle-${run.id}');
    expect(workflow).not.toContain('run.pull_requests');
    expect(workflow).not.toContain('github.rest.pulls.get');
    expect(workflow).not.toMatch(/\$\{\{[^}]*\brunner\.temp\b[^}]*\}\}/);
    expect(
      workflow.match(/^\s*GOOBERS_INSTANCE="\$RUNNER_TEMP\/goobers-shadow-instance"$/gm),
    ).toHaveLength(3);
    expect(workflow.match(/^\s*export GOOBERS_INSTANCE$/gm)).toHaveLength(3);
    expect(workflow).toContain('mkdir -p "$GOOBERS_INSTANCE/config"');
    expect(workflow).toMatch(/uses: actions\/upload-artifact@v4\s+if: always\(\)/);
    expect(workflow).toMatch(
      /path: \.goobers-shadow\/\s+if-no-files-found: error\s+include-hidden-files: true/,
    );

    for (const legacyWorkflow of ['ci-recovery.yml', 'merge-train.yml']) {
      const source = fs.readFileSync(
        path.resolve(path.dirname(modulePath), `../workflows/${legacyWorkflow}`),
        'utf8',
      );
      expect(source).toContain('legacy-lifecycle-${{ github.run_id }}');
      expect(source).toContain('capture-legacy-lifecycle.mjs');
    }
  });
});
