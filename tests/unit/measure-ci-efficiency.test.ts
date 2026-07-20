import { describe, expect, it } from 'vitest';
import {
  GitHubApiError,
  classifyFiles,
  detectSupersededRuns,
  fetchRunsInWindow,
  ghGet,
  percentile,
  __test,
} from '../../scripts/agent/ci/measure-ci-efficiency';

describe('measure-ci-efficiency helpers', () => {
  it('classifyFiles keeps src markdown out of docs_only', () => {
    expect(classifyFiles(['src/game/ai/README.md'])).toBe('full');
    expect(classifyFiles(['docs/notes.md'])).toBe('docs_only');
    expect(classifyFiles(['package.json'], { packageJsonGameplaySafe: true })).toBe(
      'gameplay_safe',
    );
  });

  it('fetchRunsInWindow paginates through post-window pages', async () => {
    const inWindowRun = {
      id: 2,
      name: 'CI',
      workflow_id: 1,
      head_branch: 'feature',
      head_sha: 'abc',
      run_number: 2,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-07-10T00:00:00Z',
      updated_at: '2026-07-10T00:10:00Z',
      run_attempt: 1,
      pull_requests: [],
      display_title: 'in-window',
    };

    const postWindowRun = {
      ...inWindowRun,
      id: 1,
      created_at: '2026-07-12T00:00:00Z',
    };

    const beforeStartRun = {
      ...inWindowRun,
      id: 3,
      created_at: '2026-07-01T00:00:00Z',
    };

    let calls = 0;
    const fakeGet = async (path: string) => {
      calls++;
      const page = Number(new URL(`https://example.com${path}`).searchParams.get('page'));
      if (page === 1) return { workflow_runs: [postWindowRun] };
      if (page === 2) return { workflow_runs: [inWindowRun, beforeStartRun] };
      return { workflow_runs: [] };
    };

    const runs = await fetchRunsInWindow(
      1,
      'ci',
      'nalfeo',
      'Crawler',
      'token',
      new Date('2026-07-05T00:00:00Z'),
      new Date('2026-07-11T00:00:00Z'),
      fakeGet as (path: string, token: string) => Promise<unknown>,
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(runs.map((run) => run.id)).toEqual([2]);
  });

  it('detectSupersededRuns returns first superseding timestamp', () => {
    const runs = [
      {
        id: 100,
        name: 'CI',
        workflow_id: 288745068,
        head_branch: 'feature',
        head_sha: 'a',
        run_number: 1,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-10T00:00:00Z',
        updated_at: '2026-07-10T00:30:00Z',
        run_attempt: 1,
        pull_requests: [{ number: 42 }],
        display_title: 'older',
      },
      {
        id: 101,
        name: 'CI',
        workflow_id: 288745068,
        head_branch: 'feature',
        head_sha: 'b',
        run_number: 2,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-07-10T00:10:00Z',
        updated_at: '2026-07-10T00:40:00Z',
        run_attempt: 1,
        pull_requests: [{ number: 42 }],
        display_title: 'newer',
      },
    ];

    const superseded = detectSupersededRuns(runs);
    expect(superseded.get(100)).toBe('2026-07-10T00:10:00Z');
    expect(superseded.has(101)).toBe(false);
  });

  it('computeAvoidableMinutes clips superseded work to post-supersede overlap', () => {
    const result = __test.computeAvoidableMinutes(
      'full',
      [
        {
          name: 'Long Job',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-10T00:00:00Z',
          completed_at: '2026-07-10T00:30:00Z',
          durationMinutes: 30,
        },
      ],
      'ci',
      '2026-07-10T00:10:00Z',
      false,
    );

    expect(result.avoidableReason).toBe('superseded');
    expect(result.avoidableMinutes).toBeCloseTo(20, 5);
    expect(result.supersededMinutes).toBeCloseTo(20, 5);
  });

  it('computeAvoidableMinutes counts coverage as avoidable for docs/sprites scopes', () => {
    const docs = __test.computeAvoidableMinutes(
      'docs_only',
      [
        {
          name: 'Unit Tests (coverage)',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-10T00:00:00Z',
          completed_at: '2026-07-10T00:10:00Z',
          durationMinutes: 10,
        },
      ],
      'ci',
      null,
      false,
    );

    const sprites = __test.computeAvoidableMinutes(
      'sprites_only',
      [
        {
          name: 'Unit Tests (coverage)',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-10T00:00:00Z',
          completed_at: '2026-07-10T00:10:00Z',
          durationMinutes: 10,
        },
      ],
      'ci',
      null,
      true,
    );

    expect(docs.avoidableMinutes).toBe(10);
    expect(sprites.avoidableMinutes).toBe(10);
  });

  it('ghGet retries primary rate-limit errors and returns next success', async () => {
    let calls = 0;
    const fakeGet = async () => {
      calls++;
      if (calls === 1) {
        throw new GitHubApiError(
          '/x',
          403,
          {
            'x-ratelimit-remaining': '0',
            // reset in the past, so test does not sleep long
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 1),
          },
          'API rate limit exceeded',
        );
      }
      return { ok: true };
    };

    const result = await ghGet(
      '/x',
      'token',
      1,
      fakeGet as (path: string, token: string) => Promise<unknown>,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('detectClassifierGapFindings marks required-check failures as gaps', () => {
    const findings = __test.detectClassifierGapFindings([
      {
        runId: 20,
        workflowKey: 'ci',
        prNumber: 5,
        branch: 'feature',
        sha: 'abc',
        createdAt: '2026-07-10T00:00:00Z',
        completedAt: '2026-07-10T00:10:00Z',
        conclusion: 'success',
        impact: 'full',
        superseded: false,
        supersededAt: null,
        supersededMinutes: 0,
        totalMinutes: 10,
        jobs: [
          {
            name: 'Detect change scope',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-07-10T00:00:00Z',
            completed_at: '2026-07-10T00:01:00Z',
            durationMinutes: 1,
          },
          {
            name: 'Unit Tests',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2026-07-10T00:00:00Z',
            completed_at: '2026-07-10T00:01:00Z',
            durationMinutes: 1,
          },
        ],
        avoidableMinutes: 0,
        avoidableReason: 'none',
        headlessMinutes: 0,
        e2eMinutes: 0,
        coverageMinutes: 1,
        securityMinutes: 0,
        spritesTouched: false,
      },
    ]);

    expect(findings.gaps.some((f) => f.includes('Unit Tests'))).toBe(true);
  });

  it('detectClassifierGapFindings marks missing required checks and unknown impact as uncertain', () => {
    const findings = __test.detectClassifierGapFindings([
      {
        runId: 10,
        workflowKey: 'ci',
        prNumber: 5,
        branch: 'feature',
        sha: 'abc',
        createdAt: '2026-07-10T00:00:00Z',
        completedAt: '2026-07-10T00:10:00Z',
        conclusion: 'success',
        impact: 'full',
        superseded: false,
        supersededAt: null,
        supersededMinutes: 0,
        totalMinutes: 10,
        jobs: [
          {
            name: 'Detect change scope',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-07-10T00:00:00Z',
            completed_at: '2026-07-10T00:01:00Z',
            durationMinutes: 1,
          },
        ],
        avoidableMinutes: 0,
        avoidableReason: 'none',
        headlessMinutes: 0,
        e2eMinutes: 0,
        coverageMinutes: 0,
        securityMinutes: 0,
        spritesTouched: false,
      },
      {
        runId: 11,
        workflowKey: 'ci',
        prNumber: 6,
        branch: 'feature',
        sha: 'def',
        createdAt: '2026-07-10T00:00:00Z',
        completedAt: '2026-07-10T00:10:00Z',
        conclusion: 'success',
        impact: 'unknown',
        superseded: false,
        supersededAt: null,
        supersededMinutes: 0,
        totalMinutes: 12,
        jobs: [],
        avoidableMinutes: 0,
        avoidableReason: 'none',
        headlessMinutes: 0,
        e2eMinutes: 0,
        coverageMinutes: 0,
        securityMinutes: 0,
        spritesTouched: false,
      },
    ]);

    expect(findings.gaps.length).toBe(0);
    expect(findings.uncertain.some((f) => f.includes('missing evidence'))).toBe(true);
    expect(findings.uncertain.some((f) => f.includes('impact unknown'))).toBe(true);
  });

  it('packageJsonGameplaySafeFromObjects mirrors detect-art-only package rules', () => {
    const safe = __test.packageJsonGameplaySafeFromObjects(
      {
        scripts: { devtools: 'vite', test: 'vitest' },
        dependencies: { a: '1.0.0' },
      },
      {
        scripts: { devtools: 'vite --host', test: 'vitest' },
        dependencies: { a: '1.0.0' },
      },
    );
    const unsafe = __test.packageJsonGameplaySafeFromObjects(
      {
        scripts: { devtools: 'vite' },
        dependencies: { a: '1.0.0' },
      },
      {
        scripts: { devtools: 'vite' },
        dependencies: { a: '1.1.0' },
      },
    );

    expect(safe).toBe(true);
    expect(unsafe).toBe(false);
  });

  it('percentile uses nearest-rank behavior', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});
