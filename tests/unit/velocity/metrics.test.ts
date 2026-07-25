import { describe, expect, it } from 'vitest';
import {
  auditCommandLeak,
  auditLeak,
  detectBudgetExhaustion,
  extractMetrics,
  extractSessionId,
  parseTranscript,
} from '../../../scripts/agent/velocity/metrics';
import type { TaskSpec } from '../../../scripts/agent/velocity/types';

/**
 * Event shapes below are copied from a real `copilot -p --output-format json`
 * run, so this test doubles as a regression guard on the transcript contract.
 */
const TRANSCRIPT = [
  JSON.stringify({ type: 'user.message', data: { content: 'go' } }),
  JSON.stringify({ type: 'model.call_start', data: { turnId: '0', model: 'gpt-5-mini' } }),
  JSON.stringify({
    type: 'assistant.message',
    data: { outputTokens: 131, model: 'gpt-5-mini', toolRequests: [{ id: 'a' }, { id: 'b' }] },
  }),
  JSON.stringify({ type: 'model.call_start', data: { turnId: '1', model: 'gpt-5-mini' } }),
  JSON.stringify({ type: 'assistant.message', data: { outputTokens: 69, toolRequests: [] } }),
  JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 100 } }),
  JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 346035000 } }),
  JSON.stringify({
    type: 'result',
    sessionId: '9a18df58-e815-43fa-be69-784dd5a98004',
    exitCode: 0,
    usage: {
      totalApiDurationMs: 4186,
      sessionDurationMs: 10844,
      codeChanges: { linesAdded: 12, linesRemoved: 3, filesModified: ['a.ts', 'b.ts'] },
    },
  }),
].join('\n');

const TASK: TaskSpec = {
  id: 'pr1930-example',
  prNumber: 1930,
  title: 'Example',
  baseCommit: 'a'.repeat(40),
  solutionCommit: 'deadbeefcafe1234567890abcdef1234567890ab',
  prompt: 'do the thing',
  verifierCommand: 'npm run test:unit',
  verifierFiles: [],
  verifierHash: 'hash',
  solutionFiles: ['src/core/thing.ts'],
};

describe('parseTranscript', () => {
  it('ignores non-JSON noise interleaved into stdout', () => {
    const events = parseTranscript(`banner text\n${TRANSCRIPT}\n{ not json }\n`);
    expect(events).toHaveLength(8);
  });
});

describe('extractMetrics', () => {
  it('derives turns, tokens, tool calls, cost, and durations from the transcript', () => {
    const metrics = extractMetrics(parseTranscript(TRANSCRIPT));
    expect(metrics.modelCalls).toBe(2);
    expect(metrics.outputTokens).toBe(200);
    expect(metrics.toolCalls).toBe(2);
    expect(metrics.sessionDurationMs).toBe(10844);
    expect(metrics.apiDurationMs).toBe(4186);
    expect(metrics.linesAdded).toBe(12);
    expect(metrics.filesModified).toBe(2);
  });

  it('takes the LAST usage checkpoint, since checkpoints are cumulative', () => {
    expect(extractMetrics(parseTranscript(TRANSCRIPT)).nanoAiu).toBe(346035000);
  });

  it('returns zeroed metrics for an empty transcript rather than throwing', () => {
    expect(extractMetrics([]).modelCalls).toBe(0);
  });
});

describe('extractSessionId', () => {
  it('reads the session id from the result event', () => {
    expect(extractSessionId(parseTranscript(TRANSCRIPT))).toBe(
      '9a18df58-e815-43fa-be69-784dd5a98004',
    );
  });

  it('returns null when the session never produced a result', () => {
    expect(extractSessionId(parseTranscript('{"type":"user.message"}'))).toBeNull();
  });
});

describe('auditLeak', () => {
  it('passes a clean transcript', () => {
    expect(auditLeak(TRANSCRIPT, TASK)).toEqual([]);
  });

  it('flags a transcript containing the solution commit sha', () => {
    const signals = auditLeak(`${TRANSCRIPT}\nlooked at deadbeefcafe1234`, TASK);
    expect(signals).toContain('solution-commit:deadbeef');
  });

  it('flags a transcript that references the original pull request', () => {
    expect(auditLeak('checking pull/1930 for context', TASK)).toContain('pr-reference:pull/1930');
    expect(auditLeak('see #1930 for the fix', TASK)).toContain('pr-reference:#1930');
  });

  it('is case-insensitive', () => {
    expect(auditLeak('DEADBEEFCAFE1234', TASK)).toContain('solution-commit:deadbeef');
  });
});

describe('detectBudgetExhaustion', () => {
  // Observed verbatim in a real trial that stopped after 3 turns at maxAiCredits=40.
  const limitWarning = {
    type: 'session.warning',
    data: {
      warningType: 'session_limits',
      message: 'Session limit reached (41.14/40 AI credits used).',
    },
  };

  it('detects a session stopped by its credit ceiling', () => {
    expect(detectBudgetExhaustion([limitWarning])).toBe(true);
  });

  it('does not confuse other warnings with budget exhaustion', () => {
    expect(
      detectBudgetExhaustion([
        { type: 'session.warning', data: { warningType: 'something_else' } },
      ]),
    ).toBe(false);
  });

  it('is false for a clean transcript', () => {
    expect(detectBudgetExhaustion(parseTranscript(TRANSCRIPT))).toBe(false);
  });
});

describe('auditCommandLeak', () => {
  it.each([
    ['gh pr view 1799 --json title', 'remote-access:gh-cli'],
    ['gh api repos/nalfeo/Crawler/pulls/1799', 'remote-access:gh-cli'],
    ['git fetch origin main', 'remote-access:git-remote-read'],
    ['git ls-remote https://github.com/nalfeo/Crawler', 'remote-access:git-remote-read'],
    ['curl https://github.com/nalfeo/Crawler/commit/abc', 'remote-access:curl-github'],
    ['fetch("https://api.github.com/repos/x")', 'remote-access:api-github'],
  ])('flags %j', (transcript, signal) => {
    expect(auditCommandLeak(transcript)).toContain(signal);
  });

  it('does not flag ordinary local work', () => {
    const benign = 'git status\ngit diff --stat\nnpx vitest run\ngrep -r foo src/';
    expect(auditCommandLeak(benign)).toEqual([]);
  });

  it('does not flag a local commit or branch operation', () => {
    expect(auditCommandLeak('git commit -m "fix"; git checkout -b x; git log')).toEqual([]);
  });
});
