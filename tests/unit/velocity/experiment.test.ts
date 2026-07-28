import { describe, expect, it } from 'vitest';
import {
  buildComparisons,
  buildVerdict,
  buildWarnings,
  contextSinks,
  isUsable,
  metricValue,
  renderReport,
  summarizeArm,
} from '../../../scripts/agent/velocity/experiment';
import {
  EXPERIMENT_SCHEMA,
  REPORT_SCHEMA,
  type ExperimentReport,
  type ExperimentSpec,
  type TrialResult,
} from '../../../scripts/agent/velocity/types';

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    taskId: 'pr42-add-foo',
    armId: 'control',
    repetition: 1,
    sessionId: 's',
    verifierPassed: true,
    verifierExitCode: 0,
    error: null,
    budgetExhausted: false,
    metrics: {
      modelCalls: 10,
      outputTokens: 1000,
      toolCalls: 20,
      nanoAiu: 5_000,
      sessionDurationMs: 60_000,
      apiDurationMs: 30_000,
      linesAdded: 5,
      linesRemoved: 1,
      filesModified: 2,
    },
    context: {
      available: true,
      compactions: 0,
      peakContextTokens: 0,
      compactionTokensUsed: 0,
      toolResultBytes: 4096,
      largestToolResultBytes: 2048,
      largestToolResultName: 'grep',
    },
    leakSignals: [],
    transcriptPath: 't.jsonl',
    startedAt: '2026-07-25T00:00:00.000Z',
    finishedAt: '2026-07-25T00:01:00.000Z',
    ...overrides,
  };
}

const spec: ExperimentSpec = {
  schema: EXPERIMENT_SCHEMA,
  id: 'exp',
  hypothesis: 'h',
  factor: 'environment',
  pack: 'pack.json',
  arms: [
    { id: 'control', description: 'baseline' },
    { id: 'treatment', description: 'with skill', setup: ['echo hi'] },
  ],
  trials: 3,
};

describe('isUsable', () => {
  it('accepts a green, uncontaminated trial', () => {
    expect(isUsable(trial())).toBe(true);
  });

  it('rejects a red trial — a fast failure is not a fast success', () => {
    expect(isUsable(trial({ verifierPassed: false }))).toBe(false);
  });

  it('rejects a green trial that tripped the leak audit', () => {
    expect(isUsable(trial({ leakSignals: ['pr-reference:#42'] }))).toBe(false);
  });
});

describe('summarizeArm', () => {
  it('computes pass rate over ALL trials but metrics over usable trials only', () => {
    const trials = [
      trial({ armId: 'control' }),
      trial({ armId: 'control', metrics: { ...trial().metrics, modelCalls: 20 } }),
      trial({ armId: 'control', verifierPassed: false }),
    ];
    const summary = summarizeArm('control', 'baseline', trials);
    expect(summary.trials).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.passRate).toBeCloseTo(2 / 3);
    // Only the two green trials feed the median (10 and 20).
    expect(summary.modelCalls.n).toBe(2);
    expect(summary.modelCalls.median).toBe(15);
  });

  it('excludes leaked trials from both the metric sample and the pass count', () => {
    const summary = summarizeArm('control', 'baseline', [
      trial({ leakSignals: ['solution-commit:abc'] }),
    ]);
    expect(summary.passed).toBe(0);
    expect(summary.modelCalls.n).toBe(0);
  });
});

describe('buildVerdict', () => {
  it('says INCONCLUSIVE loudly when nothing separates the arms', () => {
    const verdict = buildVerdict([
      {
        metric: 'modelCalls',
        baselineArm: 'control',
        treatmentArm: 'treatment',
        baselineMedian: 10,
        treatmentMedian: 10,
        medianDelta: 0,
        ci95: [-4, 4],
        cliffsDelta: 0,
        effectSizeLabel: 'negligible',
        conclusive: false,
      },
    ]);
    expect(verdict).toMatch(/^INCONCLUSIVE/);
    expect(verdict).toMatch(/absence of evidence/);
  });

  it('reports direction and effect size for a conclusive comparison', () => {
    const verdict = buildVerdict([
      {
        metric: 'modelCalls',
        baselineArm: 'control',
        treatmentArm: 'treatment',
        baselineMedian: 20,
        treatmentMedian: 12,
        medianDelta: -8,
        ci95: [-12, -4],
        cliffsDelta: -0.8,
        effectSizeLabel: 'large',
        conclusive: true,
      },
    ]);
    expect(verdict).toMatch(/^CONCLUSIVE/);
    expect(verdict).toMatch(/reduced median modelCalls/);
  });
});

describe('buildWarnings', () => {
  it('warns about leaked trials, naming them', () => {
    const trials = [trial({ leakSignals: ['pr-reference:#42'] })];
    const warnings = buildWarnings(spec, trials, [summarizeArm('control', 'baseline', trials)]);
    expect(warnings.join('\n')).toMatch(/leak audit/);
  });

  it('warns when an arm has too few usable trials to be conclusive', () => {
    const trials = [trial()];
    const warnings = buildWarnings(spec, trials, [summarizeArm('control', 'baseline', trials)]);
    expect(warnings.join('\n')).toMatch(/usable trial/);
  });

  it('warns when an arm never went green', () => {
    const trials = [trial({ verifierPassed: false })];
    const warnings = buildWarnings(spec, trials, [summarizeArm('control', 'baseline', trials)]);
    expect(warnings.join('\n')).toMatch(/never reached a passing verifier/);
  });

  it('flags a smoke-sized run as not being evidence', () => {
    const warnings = buildWarnings({ ...spec, trials: 1 }, [], []);
    expect(warnings.join('\n')).toMatch(/smoke test of the harness/);
  });
});

describe('buildWarnings — budget censoring', () => {
  it('flags budget-exhausted trials as censored rather than failed', () => {
    const trials = [trial({ budgetExhausted: true, verifierPassed: false })];
    const warnings = buildWarnings({ ...spec, maxAiCredits: 40 }, trials, [
      summarizeArm('control', 'baseline', trials),
    ]);
    const censoring = warnings.find((w) => w.includes('AI-credit ceiling'));
    expect(censoring).toBeDefined();
    expect(censoring).toContain('maxAiCredits=40');
    expect(censoring).toContain('censored, not failed');
  });

  it('says nothing about budget when no trial hit the ceiling', () => {
    const trials = [trial()];
    const warnings = buildWarnings(spec, trials, [summarizeArm('control', 'baseline', trials)]);
    expect(warnings.some((w) => w.includes('AI-credit ceiling'))).toBe(false);
  });
});

describe('contextSinks', () => {
  it('ranks tools by total context consumed and ignores untracked trials', () => {
    const trials = [
      trial({
        context: {
          available: true,
          compactions: 0,
          peakContextTokens: 0,
          compactionTokensUsed: 0,
          toolResultBytes: 10,
          largestToolResultBytes: 10,
          largestToolResultName: 'grep',
        },
      }),
      trial({
        context: {
          available: true,
          compactions: 0,
          peakContextTokens: 0,
          compactionTokensUsed: 0,
          toolResultBytes: 30,
          largestToolResultBytes: 30,
          largestToolResultName: 'grep',
        },
      }),
      trial({
        context: {
          available: true,
          compactions: 0,
          peakContextTokens: 0,
          compactionTokensUsed: 0,
          toolResultBytes: 25,
          largestToolResultBytes: 25,
          largestToolResultName: 'view',
        },
      }),
      trial({
        context: {
          available: true,
          compactions: 0,
          peakContextTokens: 0,
          compactionTokensUsed: 0,
          toolResultBytes: 99,
          largestToolResultBytes: 99,
          largestToolResultName: null,
        },
      }),
    ];
    expect(contextSinks(trials)).toEqual([
      { tool: 'grep', bytes: 40 },
      { tool: 'view', bytes: 25 },
    ]);
  });

  it('returns nothing when no trial has attributed telemetry', () => {
    expect(contextSinks([])).toEqual([]);
  });
});

describe('context-efficiency comparisons', () => {
  it('reads context metrics off the context record, not the transcript metrics', () => {
    const t = trial({
      context: {
        available: true,
        compactions: 3,
        peakContextTokens: 1,
        compactionTokensUsed: 2,
        toolResultBytes: 4096,
        largestToolResultBytes: 1,
        largestToolResultName: 'grep',
      },
    });
    expect(metricValue(t, 'toolResultBytes')).toBe(4096);
    expect(metricValue(t, 'compactions')).toBe(3);
    expect(metricValue(t, 'modelCalls')).toBe(t.metrics.modelCalls);
  });
});

describe('renderReport', () => {
  function report(trials: TrialResult[]) {
    const spec: ExperimentSpec = {
      schema: EXPERIMENT_SCHEMA,
      id: 'x',
      hypothesis: 'h',
      factor: 'model',
      pack: 'packs/p.json',
      arms: [
        { id: 'control', description: 'c' },
        { id: 'treatment', description: 't' },
      ],
      trials: 1,
    };
    const arms = spec.arms.map((a) => summarizeArm(a.id, a.description, trials));
    const built: ExperimentReport = {
      schema: REPORT_SCHEMA,
      experimentId: 'x',
      hypothesis: 'h',
      factor: 'model',
      packId: 'p',
      startedAt: '2026-07-25T00:00:00.000Z',
      finishedAt: '2026-07-25T00:10:00.000Z',
      arms,
      comparisons: buildComparisons(spec, trials),
      trials,
      verdict: 'INCONCLUSIVE',
      warnings: buildWarnings(spec, trials, arms),
    };
    return built;
  }

  it('shows context columns and names the biggest sink', () => {
    const out = renderReport(report([trial(), trial({ armId: 'treatment' })]));
    expect(out).toContain('MedToolKB');
    expect(out).toContain('Compact');
    expect(out).toContain('Biggest context sinks');
    expect(out).toContain('grep');
  });

  it('renders without a sinks section when nothing was attributed', () => {
    const bare = trial({
      context: {
        available: true,
        compactions: 0,
        peakContextTokens: 0,
        compactionTokensUsed: 0,
        toolResultBytes: 0,
        largestToolResultBytes: 0,
        largestToolResultName: null,
      },
    });
    expect(renderReport(report([bare]))).not.toContain('Biggest context sinks');
  });

  it('never crashes on an experiment with no usable trials', () => {
    const failed = trial({ verifierPassed: false });
    expect(() => renderReport(report([failed]))).not.toThrow();
  });
});

describe('review-hardening regressions', () => {
  it('excludes an errored trial even when its verifier happened to pass', () => {
    // A crashed launch produces zero turns/tokens. If counted, the crash would
    // rank as the fastest run in the experiment.
    const crashed = trial({ verifierPassed: true, error: 'copilot failed to launch' });
    expect(isUsable(crashed)).toBe(false);
  });

  it('keeps a green trial with no error usable', () => {
    expect(isUsable(trial({ verifierPassed: true, error: null }))).toBe(true);
  });

  it('does not summarize unmeasured context as zero', () => {
    const measured = trial({
      armId: 'a',
      verifierPassed: true,
      context: {
        available: true,
        compactions: 4,
        peakContextTokens: 0,
        compactionTokensUsed: 0,
        toolResultBytes: 100,
        largestToolResultBytes: 0,
        largestToolResultName: null,
      },
    });
    const unmeasured = trial({
      armId: 'a',
      verifierPassed: true,
      context: {
        available: false,
        compactions: 0,
        peakContextTokens: 0,
        compactionTokensUsed: 0,
        toolResultBytes: 0,
        largestToolResultBytes: 0,
        largestToolResultName: null,
      },
    });
    const summary = summarizeArm('a', '', [measured, unmeasured]);
    // Median over [4], not over [0, 4].
    expect(summary.compactions.median).toBe(4);
    expect(summary.toolResultBytes.median).toBe(100);
  });
});

describe('passRate integrity', () => {
  it('does not count a crashed trial as a pass even if its verifier passed', () => {
    const summary = summarizeArm('a', '', [
      trial({ armId: 'a', verifierPassed: true }),
      trial({ armId: 'a', verifierPassed: true, error: 'copilot failed to launch' }),
    ]);
    expect(summary.passed).toBe(1);
    expect(summary.passRate).toBe(0.5);
  });

  it('does not count a leaked trial as a pass', () => {
    const summary = summarizeArm('a', '', [
      trial({ armId: 'a', verifierPassed: true, leakSignals: ['remote-access:gh-cli'] }),
    ]);
    expect(summary.passed).toBe(0);
    expect(summary.passRate).toBe(0);
  });
});
