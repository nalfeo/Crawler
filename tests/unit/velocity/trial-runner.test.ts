import { describe, expect, it } from 'vitest';
import {
  buildCopilotArgs,
  buildTrialEnv,
  DEFAULT_DENY_TOOLS,
  quoteShellArg,
  toShellCommand,
  TRIAL_ENV_SCRUB,
  TRIAL_PROMPT,
} from '../../../scripts/agent/velocity/trial-runner';
import type { ArmSpec } from '../../../scripts/agent/velocity/types';

const arm = (overrides: Partial<ArmSpec> = {}): ArmSpec => ({
  id: 'a',
  description: 'd',
  ...overrides,
});

const options = (overrides: Record<string, unknown> = {}) =>
  ({
    repoRoot: 'C:/repo',
    trialsRoot: 'C:/snap',
    experimentId: 'exp',
    repetition: 1,
    timeoutMs: 60_000,
    install: false,
    denyTools: [...DEFAULT_DENY_TOOLS],
    ...overrides,
  }) as Parameters<typeof buildCopilotArgs>[1];

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('buildCopilotArgs', () => {
  it('passes a single-line prompt so the Windows shell cannot mangle it', () => {
    const args = buildCopilotArgs(arm(), options(), 'sid', 'C:/snap/t');
    expect(valueAfter(args, '-p')).toBe(TRIAL_PROMPT);
    expect(TRIAL_PROMPT).not.toContain('\n');
  });

  it('runs the agent in the isolated snapshot, not the host repo', () => {
    const args = buildCopilotArgs(arm(), options(), 'sid', 'C:/snap/t');
    expect(valueAfter(args, '-C')).toBe('C:/snap/t');
  });

  it('does not grant global filesystem access to the trial agent', () => {
    const args = buildCopilotArgs(arm(), options(), 'sid', 'C:/snap/t');
    expect(args).not.toContain('--allow-all-paths');
  });

  it('pins the session id so the transcript can be attributed to this trial', () => {
    const args = buildCopilotArgs(arm(), options(), 'sid-123', 'C:/snap/t');
    expect(valueAfter(args, '--session-id')).toBe('sid-123');
  });

  it('runs non-interactively with a machine-readable transcript', () => {
    const args = buildCopilotArgs(arm(), options(), 'sid', 'C:/snap/t');
    expect(args).toContain('--no-ask-user');
    expect(valueAfter(args, '--output-format')).toBe('json');
  });

  it('applies the arm model config rather than an ambient default', () => {
    const args = buildCopilotArgs(
      arm({ model: 'gpt-5.4', reasoningEffort: 'high', contextTier: 'long_context' }),
      options({ defaultModel: 'ignored-when-arm-overrides' }),
      'sid',
      'C:/snap/t',
    );
    expect(valueAfter(args, '--model')).toBe('gpt-5.4');
    expect(valueAfter(args, '--effort')).toBe('high');
    expect(valueAfter(args, '--context')).toBe('long_context');
  });

  it('falls back to the experiment default model when the arm does not override it', () => {
    const args = buildCopilotArgs(
      arm(),
      options({ defaultModel: 'claude-sonnet-4.6' }),
      'sid',
      'C:/s',
    );
    expect(valueAfter(args, '--model')).toBe('claude-sonnet-4.6');
  });

  it('denies the tools that could fetch the original solution from the internet', () => {
    const args = buildCopilotArgs(arm(), options(), 'sid', 'C:/s');
    for (const tool of DEFAULT_DENY_TOOLS) {
      expect(args).toContain(tool);
    }
  });
});

describe('toShellCommand', () => {
  it('quotes every argument, so a prompt with spaces stays one argument', () => {
    const command = toShellCommand('copilot', ['-p', 'two words']);
    expect(command).toContain(quoteShellArg('two words'));
    // The bug this guards: unquoted concatenation made the CLI reject the call.
    expect(command).not.toBe('copilot -p two words');
  });

  it('quotes paths containing spaces', () => {
    expect(toShellCommand('copilot', ['-C', 'C:/my dir/x'])).toContain('my dir');
    expect(
      quoteShellArg('C:/my dir/x').startsWith("'") || quoteShellArg('C:/my dir/x').startsWith('"'),
    ).toBe(true);
  });
});

describe('buildTrialEnv', () => {
  it('removes every credential that could fetch the real solution', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const key of TRIAL_ENV_SCRUB) base[key] = 'secret';
    const env = buildTrialEnv(base);
    for (const key of TRIAL_ENV_SCRUB) expect(env[key]).toBeUndefined();
  });

  it('keeps the rest of the environment so the toolchain still works', () => {
    const env = buildTrialEnv({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
  });

  it('stops git from prompting for or reusing stored credentials', () => {
    const env = buildTrialEnv({});
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('does not mutate the environment it was given', () => {
    const base: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'secret' };
    buildTrialEnv(base);
    expect(base.GITHUB_TOKEN).toBe('secret');
  });
});

describe('DEFAULT_DENY_TOOLS', () => {
  it('denies repo-reading MCP tools, not just web search', () => {
    expect(DEFAULT_DENY_TOOLS).toContain('github-mcp-server-get_file_contents');
    expect(DEFAULT_DENY_TOOLS).toContain('github-mcp-server-search_code');
    expect(DEFAULT_DENY_TOOLS).toContain('session_store_sql');
  });
});
