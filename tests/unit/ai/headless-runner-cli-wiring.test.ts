/**
 * Regression coverage for the REAL CLI -> runner wiring seam.
 *
 * `headless-runner-cli-lib.test.ts` only exercises the pure
 * `resolveHeadlessRunnerOptions` helper, which can stay green while the CLI
 * entrypoint forgets to forward the resolved option (or forwards an explicit
 * `undefined` that clobbers the runner's own floor defaults). This suite loads
 * the actual `headless-runner-cli.ts` entrypoint and captures the exact config
 * object it hands to the real `runHeadless` export.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessRunnerConfig } from '../../../src/game/ai/headless-runner.js';

const CLI_MODULE = '../../../src/game/ai/headless-runner-cli.js';

/** Thrown by the stubbed runner so the CLI never renders a full RunStats report. */
const STOP_AFTER_CAPTURE = Symbol('stop-after-capture');

const capturedConfigs: HeadlessRunnerConfig[] = [];
let runnerInvoked: () => void = () => {};

vi.mock('../../../src/game/ai/headless-runner.js', () => ({
  runHeadless: (_ai: unknown, config: HeadlessRunnerConfig) => {
    capturedConfigs.push(config);
    runnerInvoked();
    throw STOP_AFTER_CAPTURE;
  },
}));

/**
 * Runs the real CLI entrypoint with `argv`/`env` and returns the config it
 * passed to `runHeadless`. The CLI calls `main()` at module load and exits the
 * process at the end of a run, so both `process.exit` and console output are
 * stubbed for the duration of the import.
 */
async function captureRunnerConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<HeadlessRunnerConfig> {
  const originalArgv = process.argv;
  const originalEnvEntries = Object.entries(env).map(
    ([key, value]) => [key, process.env[key], value] as const,
  );
  const before = capturedConfigs.length;
  let resolveInvoked: () => void = () => {};
  const invoked = new Promise<void>((resolve) => {
    resolveInvoked = resolve;
  });
  runnerInvoked = resolveInvoked;

  process.argv = ['node', 'headless-runner-cli.js', ...argv];
  for (const [key, , value] of originalEnvEntries) {
    process.env[key] = value;
  }

  try {
    vi.resetModules();
    await import(CLI_MODULE);
    await invoked;
  } finally {
    process.argv = originalArgv;
    for (const [key, previous] of originalEnvEntries) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    runnerInvoked = () => {};
  }

  const captured = capturedConfigs[before];
  expect(captured).toBeDefined();
  return captured as HeadlessRunnerConfig;
}

describe('headless-runner-cli — runner wiring', () => {
  beforeEach(() => {
    capturedConfigs.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes settlementReturnRouting: true to the runner for --floor floor2 when explicitly requested', async () => {
    const config = await captureRunnerConfig([
      '--floor',
      'floor2',
      '--max-frames',
      '1',
      '--settlement-return-routing',
    ]);

    expect(config.floorId).toBe('floor2');
    expect(config.settlementReturnRouting).toBe(true);
  });

  it('omits settlementReturnRouting entirely on every floor (including floor2) so the runner/registry own the defaults', async () => {
    const floor1 = await captureRunnerConfig(['--floor', 'floor1', '--max-frames', '1']);
    const floor2 = await captureRunnerConfig(['--floor', 'floor2', '--max-frames', '1']);
    const floor3 = await captureRunnerConfig(['--floor', 'floor3', '--max-frames', '1']);

    // `in` (not `=== undefined`): an explicit `settlementReturnRouting: undefined`
    // would override `DEFAULT_CONFIG` in the runner's `{ ...DEFAULT_CONFIG, ...config }`
    // spread and defeat its Floor 1 auto-enable branch.
    //
    // Regression: the CLI resolver used to force `settlementReturnRouting: true`
    // into the config whenever `--floor floor2` was passed with no explicit
    // flag, contradicting the registry's own floor2 default (`false`).
    expect('settlementReturnRouting' in floor1).toBe(false);
    expect('settlementReturnRouting' in floor2).toBe(false);
    expect('settlementReturnRouting' in floor3).toBe(false);
  });

  it('forwards an explicit opt-out on Floor 2 instead of the floor default', async () => {
    const config = await captureRunnerConfig(['--floor', 'floor2', '--max-frames', '1'], {
      AI_SETTLEMENT_RETURN_ROUTING: 'false',
    });

    expect(config.settlementReturnRouting).toBe(false);
  });

  it('omits weaponPersonas/optionalPurchases unless explicitly overridden so the registry owns the defaults', async () => {
    const config = await captureRunnerConfig(['--floor', 'floor1', '--max-frames', '1']);

    expect('weaponPersonas' in config).toBe(false);
    expect('optionalPurchases' in config).toBe(false);
  });

  it('forwards explicit weaponPersonas/optionalPurchases opt-outs to the runner', async () => {
    const config = await captureRunnerConfig([
      '--floor',
      'floor1',
      '--max-frames',
      '1',
      '--no-weapon-personas',
      '--no-optional-purchases',
    ]);

    expect(config.weaponPersonas).toBe(false);
    expect(config.optionalPurchases).toBe(false);
  });

  it('omits attackWaves/floor1Spawners unless explicitly overridden so the registry owns the default-off values', async () => {
    const config = await captureRunnerConfig(['--floor', 'floor1', '--max-frames', '1']);

    expect('attackWaves' in config).toBe(false);
    expect('floor1Spawners' in config).toBe(false);
  });

  it('forwards explicit --attack-waves and --floor1-spawners to the runner', async () => {
    const config = await captureRunnerConfig([
      '--floor',
      'floor1',
      '--max-frames',
      '1',
      '--attack-waves',
      '--floor1-spawners',
    ]);

    expect(config.attackWaves).toBe(true);
    expect(config.floor1Spawners).toBe(true);
  });

  it('forwards explicit --no-attack-waves and --no-floor1-spawners to the runner', async () => {
    const config = await captureRunnerConfig([
      '--floor',
      'floor1',
      '--max-frames',
      '1',
      '--no-attack-waves',
      '--no-floor1-spawners',
    ]);

    expect(config.attackWaves).toBe(false);
    expect(config.floor1Spawners).toBe(false);
  });

  it('leaves enforcePlayabilityInvariants unset so Floor 2 CLI runs keep the invariant gate', async () => {
    const config = await captureRunnerConfig(['--floor', 'floor2', '--max-frames', '1']);

    expect('enforcePlayabilityInvariants' in config).toBe(false);
  });
});
