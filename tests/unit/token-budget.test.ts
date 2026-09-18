import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkBudget,
  main,
  parseArgs,
  parseRolloutJsonl,
  renderReport,
  summarizeRollout,
} from '../../scripts/agent/velocity/token-budget';

const fixture = [
  '{"type":"token_usage_record","payload":{"usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":8,"reasoning_output_tokens":3}}}',
  '{"type":"response_item","payload":{"type":"function_call","name":"shell"}}',
  '{"type":"response_item","payload":{"type":"custom_tool_call","name":"edit"}}',
  '{"type":"response_item","payload":{"type":"function_call_output","output":"12345"}}',
  '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":{"message":"abcdef"}}}',
  '{"type":"compacted","payload":{}}',
  'not valid JSON',
  '{"type":"token_usage_record","payload":{"usage":{"input_tokens":250,"cached_input_tokens":300,"output_tokens":13,"reasoning_output_tokens":5}}}',
].join('\n');

describe('token budget rollout summary', () => {
  it('totals usage, counts events, and tolerates a partial line', () => {
    const summary = summarizeRollout(parseRolloutJsonl(fixture));
    expect(summary).toMatchObject({
      inputTokens: 350,
      cachedInputTokens: 290,
      uncachedInputTokens: 60,
      outputTokens: 21,
      reasoningTokens: 8,
      responses: 2,
      toolCalls: 2,
      compactions: 1,
      currentInputTokens: 250,
      firstRequestInputTokens: 100,
      currentContextEstimate: 250,
      largestToolOutputChars: 20,
    });
  });

  it('fails explicit budget limits but treats oversized tool output as a warning', () => {
    const summary = summarizeRollout(parseRolloutJsonl(fixture));
    const check = checkBudget(summary, {
      currentInput: 200,
      cumulativeInput: 300,
      responses: 1,
      currentContextEstimate: 200,
      toolOutputChars: 10,
    });
    expect(check.failures).toHaveLength(4);
    expect(check.warnings).toEqual(['largest tool output 20 chars > 10 chars']);
  });

  it('accepts disabled thresholds and overrides from the command line', () => {
    const args = parseArgs([
      'fixture.jsonl',
      '--max-current-input',
      'off',
      '--max-cumulative-input',
      '999',
      '--max-responses',
      '2',
      '--max-context',
      '80',
      '--max-tool-output-chars',
      '12',
      '--json',
    ]);
    expect(args.file).toMatch(/fixture\.jsonl$/u);
    expect(args.thresholds).toEqual({
      currentInput: null,
      cumulativeInput: 999,
      responses: 2,
      currentContextEstimate: 80,
      toolOutputChars: 12,
    });
    expect(args.json).toBe(true);
  });

  it('labels unavailable context instead of inventing a zero', () => {
    const summary = summarizeRollout([]);
    expect(
      renderReport(
        'empty.jsonl',
        summary,
        checkBudget(summary, {
          currentInput: 50_000,
          cumulativeInput: 500_000,
          responses: 12,
          currentContextEstimate: 80_000,
          toolOutputChars: 10_000,
        }),
      ),
    ).toContain('current-context estimate: unavailable');
    expect(
      renderReport(
        'empty.jsonl',
        summary,
        checkBudget(summary, {
          currentInput: null,
          cumulativeInput: null,
          responses: null,
          currentContextEstimate: null,
          toolOutputChars: null,
        }),
      ),
    ).toContain('first request input: unavailable');
  });

  it('returns nonzero when an explicit failure threshold is exceeded', () => {
    const directory = mkdtempSync(join(tmpdir(), 'token-budget-'));
    const file = join(directory, 'rollout.jsonl');
    writeFileSync(file, fixture);
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(
        main([
          '--file',
          file,
          '--max-current-input',
          '200',
          '--max-cumulative-input',
          'off',
          '--max-responses',
          'off',
          '--max-context',
          'off',
        ]),
      ).toBe(1);
    } finally {
      process.stdout.write = write;
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
