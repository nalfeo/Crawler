import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, sanitizeStatus } from '../../../scripts/sprites/theme-equipment-cli.js';
import * as runnerModule from '../../../scripts/sprites/theme-equipment-runner.js';
import {
  ThemeEquipmentRunner,
  ThemeEquipmentSetPhasePartialError,
} from '../../../scripts/sprites/theme-equipment-runner.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

const REPO_ROOT = path.resolve(process.cwd());
const NOW = () => new Date('2026-07-25T04:07:30.322Z');

function memoryStore(): RunStore & { readonly mem: Map<string, Buffer>; puts: number } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    puts: 0,
    backend: 'local',
    async put(key, value) {
      this.puts += 1;
      mem.set(key, value);
    },
    async get(key) {
      const value = mem.get(key);
      if (!value) throw new StoreNotFoundError(key);
      return value;
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((key) => key.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return `memory://${key}`;
    },
  };
}

/** Build a real, clean roster-phase state via the runner's own init path. */
async function makeRealState() {
  const subject = new ThemeEquipmentRunner({
    repoRoot: REPO_ROOT,
    store: memoryStore(),
    now: NOW,
    env: {},
    synthProvider: {} as never,
    briefSelectorProvider: null,
    imageProvider: {} as never,
    textProvider: null,
    visionProvider: {
      modelDeployment: 'vision-test',
      evaluate: vi.fn(async () => ({
        json: { score: 4, rationale: 'all items share the authored language' },
        usage: null,
        modelDeployment: 'vision-test',
      })),
    },
    queueCommitDeps: {} as never,
  });
  return subject.init('data/theme-equipment-sets/classic-fantasy.json');
}

describe('theme-equipment-cli parseArgs', () => {
  it('parses each action with its required selector', () => {
    expect(parseArgs(['init', '--plan', 'data/theme-equipment-sets/classic-fantasy.json'])).toEqual(
      {
        action: 'init',
        planPath: 'data/theme-equipment-sets/classic-fantasy.json',
      },
    );
    expect(parseArgs(['run-phase', '--set-id', 'classic-fantasy'])).toEqual({
      action: 'run-phase',
      setId: 'classic-fantasy',
    });
    expect(parseArgs(['publish', '--set-id', 'classic-fantasy']).action).toBe('publish');
  });

  it('rejects missing and incompatible action arguments', () => {
    expect(() => parseArgs(['init'])).toThrow(/requires --plan/);
    expect(() => parseArgs(['status'])).toThrow(/requires --set-id/);
    expect(() => parseArgs(['init', '--plan', 'x.json', '--set-id', 'x'])).toThrow(/omit --set-id/);
  });
});

describe('theme-equipment-cli main partial-checkpoint contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the sanitized checkpoint state on stdout and exits 1 on a partial phase pass', async () => {
    const state = await makeRealState();
    const partial = new ThemeEquipmentSetPhasePartialError(
      `Checkpointed 1 item(s): ${state.items[0]!.id}. Failed 1 item(s): sandals (0 acceptable variants). Re-run with: run-phase --set-id ${state.id}`,
      state,
      [state.items[0]!.id],
      [{ itemId: 'sandals', message: '0 acceptable variants', cause: new Error('sandals') }],
      null,
    );
    // The runner's deps are irrelevant: runPhase is stubbed to surface a
    // partial-success checkpoint. Stub deps construction so no real store or
    // providers are needed.
    vi.spyOn(runnerModule, 'createThemeEquipmentRunnerDeps').mockReturnValue({} as never);
    vi.spyOn(ThemeEquipmentRunner.prototype, 'runPhase').mockRejectedValue(partial);

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });

    const code = await main(['run-phase', '--set-id', state.id], REPO_ROOT);

    // Partial success is a non-zero "not fully done" signal — but the accepted
    // work IS checkpointed, so the sanitized state (with markers) goes to stdout
    // and the driver-facing re-run guidance goes to stderr.
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual(sanitizeStatus(state));
    expect(err.join('')).toMatch(/partially completed/);
    expect(err.join('')).toMatch(/0 acceptable variants/);
  });

  it('exits 1 without a state dump on a truly fatal (non-partial) error', async () => {
    vi.spyOn(runnerModule, 'createThemeEquipmentRunnerDeps').mockReturnValue({} as never);
    vi.spyOn(ThemeEquipmentRunner.prototype, 'runPhase').mockRejectedValue(
      new Error('azure exploded'),
    );
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });

    const code = await main(['run-phase', '--set-id', 'whatever'], REPO_ROOT);

    expect(code).toBe(1);
    // A fatal error must NOT emit a misleading checkpoint on stdout.
    expect(out.join('')).toBe('');
    expect(err.join('')).toMatch(/failed: azure exploded/);
  });
});
