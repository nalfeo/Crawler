import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  PR_SWEEP_LEGS,
  RELEASE_SWEEP_LEGS,
  legCliArgs,
  type SweepLeg,
} from '../../scripts/agent/perf/sweep-legs.js';
import { parseSweepArgs, type CLIArgs } from '../../scripts/agent/perf/winrate-sweep-args.js';
import { GATE_FORCE_WEAPON, GATE_SEEDS } from '../../scripts/agent/perf/floor1-gate-sample.js';

/**
 * `sweep-legs.ts` claims to be the single source of truth for what CI and the
 * release job actually run, but both workflows spell their invocations out in
 * YAML. Without this test a matrix edit stays green while CI keeps running the
 * old seeds/flags — exactly the drift the canonical module exists to prevent.
 *
 * Parity is asserted on the PARSED arguments (via the sweep's own parser), not
 * on raw strings, so flag order and equivalent spellings (an omitted
 * `--floor floor1`, an explicit weapon list vs the default) do not produce
 * false failures while a real coverage change still does.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface WorkflowStep {
  name?: string;
  run?: string;
}
interface WorkflowJob {
  strategy?: { matrix?: { include?: Array<Record<string, string | number>> } };
  steps?: WorkflowStep[];
}
interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(relativePath: string): WorkflowDoc {
  return parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as WorkflowDoc;
}

/** Collapse shell line continuations so one command occupies one line. */
function joinContinuations(script: string): string[] {
  return script
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The coverage-relevant shape of an invocation, independent of flag order. */
function coverage(args: CLIArgs): {
  floorId: string;
  seeds: number[];
  weapons: string[];
  forceWeapon: boolean;
  chain: boolean;
} {
  return {
    floorId: args.floorId,
    seeds: args.seeds,
    weapons: args.weapons,
    forceWeapon: args.forceWeapon,
    chain: args.chain,
  };
}

function parseTokens(tokens: readonly string[]): CLIArgs {
  return parseSweepArgs(['node', 'winrate-sweep.ts', ...tokens], 4);
}

function expectedCoverage(leg: SweepLeg): ReturnType<typeof coverage> {
  return coverage(parseTokens(legCliArgs(leg, 'files/expected.json')));
}

describe('PR sweep leg matrix parity with ci.yml', () => {
  const doc = loadWorkflow('.github/workflows/ci.yml');
  const include = doc.jobs['test-headless-multifloor']?.strategy?.matrix?.include ?? [];

  it('runs exactly the non-blocking PR legs declared in sweep-legs.ts', () => {
    const expected = PR_SWEEP_LEGS.filter((leg) => !leg.blocking);
    expect(include.map((entry) => entry.leg).sort()).toEqual(expected.map((leg) => leg.id).sort());

    for (const leg of expected) {
      const entry = include.find((candidate) => candidate.leg === leg.id);
      expect(entry, `matrix entry for ${leg.id}`).toBeDefined();
      expect(coverage(parseTokens(entry!.args!.split(/\s+/))), `${leg.id} args`).toEqual(
        expectedCoverage(leg),
      );
    }
  });

  it('keeps the blocking PR Floor-1 leg in lockstep with the headless gate sample', () => {
    // The blocking Floor-1 leg is executed by the headless gate, not the sweep
    // CLI, so its parity partner is the gate sample rather than a YAML command.
    const floor1 = PR_SWEEP_LEGS.find((leg) => leg.id === 'floor1');
    expect(floor1?.blocking).toBe(true);
    expect(floor1?.seedCount).toBe(GATE_SEEDS.length);
    expect(floor1?.weapons === null).toBe(!GATE_FORCE_WEAPON);
  });
});

describe('release sweep leg matrix parity with deploy.yml', () => {
  const doc = loadWorkflow('.github/workflows/deploy.yml');
  const step = Object.values(doc.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === 'Run multi-floor release sweep');

  it('runs exactly the release legs declared in sweep-legs.ts', () => {
    expect(step?.run, 'release sweep step').toBeDefined();
    const blockingInvocations = joinContinuations(step!.run!)
      .filter((line) => line.includes('ai:winrate-sweep'))
      .map((line) =>
        line
          .replace(/\s*\|\|.*$/, '')
          .split(/\s+/)
          .slice(line.split(/\s+/).indexOf('--') + 1),
      );

    const blockingLegs = RELEASE_SWEEP_LEGS.filter((leg) => leg.blocking);
    expect(blockingInvocations).toHaveLength(blockingLegs.length);
    const actualBlocking = blockingInvocations.map((tokens) => coverage(parseTokens(tokens)));
    for (const leg of blockingLegs.map(expectedCoverage)) {
      expect(actualBlocking, `blocking release leg ${leg.floorId}`).toContainEqual(leg);
    }

    const reportJob = doc.jobs['release-report-sweep'];
    const reportScript =
      reportJob?.steps?.find((candidate) => candidate.name === 'Run report shard')?.run ?? '';
    expect(reportScript, 'report shard script').toContain('--floor floor2');
    expect(reportScript, 'report shard script').toContain('--floor floor1');
    expect(reportScript, 'report shard script').toContain('--no-force-weapon');
    expect(reportScript, 'report shard script').toContain('--chain');

    const matrix = reportJob?.strategy?.matrix?.include ?? [];
    const reportLegs = RELEASE_SWEEP_LEGS.filter((leg) => !leg.blocking);
    expect(matrix.map((entry) => String(entry.leg)).sort()).toEqual(
      reportLegs.flatMap((leg) => Array.from({ length: leg.seedCount / 10 }, () => leg.id)).sort(),
    );

    for (const leg of reportLegs) {
      const entries = matrix
        .filter((entry) => entry.leg === leg.id)
        .map((entry) => Number(entry.shard))
        .sort((a, b) => a - b);
      expect(entries, `${leg.id} shards`).toEqual(
        Array.from({ length: leg.seedCount / 10 }, (_, shard) => shard),
      );

      const coveredSeeds = entries.flatMap((shard) => {
        const start = shard * 10 + 1;
        return Array.from({ length: 10 }, (_, offset) => start + offset);
      });
      expect(coveredSeeds, `${leg.id} covered seeds`).toEqual(expectedCoverage(leg).seeds);
    }
  });
});
