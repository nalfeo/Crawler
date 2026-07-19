import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMaterializationPlan,
  materializeChildIssues,
  patchEpicStateIssues,
  type EpicState,
  type GithubWriteRunner,
} from '../../../scripts/agent/epics/epic-status-lib';

const REPO_ROOT = process.cwd();
const EPIC_DIR = resolve(REPO_ROOT, 'docs', 'knowledge', 'epics', 'floor-2-equipment');
const STATE = JSON.parse(readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8')) as EpicState;

/** Build a state where all nodes (except A0 which is special-cased) have no issues. */
function stateWithNoIssues(): EpicState {
  const state = structuredClone(STATE);
  for (const node of state.nodes) {
    if (node.node_id !== 'slice:A0') {
      (node as Record<string, unknown>)['github'] = {
        ...(node.github as Record<string, unknown>),
        issue: null,
      };
    }
  }
  return state;
}

/** Build a state where ALL nodes (including A1+) have issues. */
function stateWithAllIssues(): EpicState {
  const state = structuredClone(STATE);
  let issueNumber = 9000;
  for (const node of state.nodes) {
    if (!node.github.issue) {
      (node as Record<string, unknown>)['github'] = {
        ...(node.github as Record<string, unknown>),
        issue: {
          number: issueNumber,
          url: `https://github.com/nalfeo/Crawler/issues/${issueNumber}`,
        },
      };
      issueNumber++;
    }
  }
  return state;
}

/** A write runner that records calls and returns synthetic issue objects. */
function makeMockWriteRunner(
  existingIssues: Array<{
    number: number;
    title: string;
    html_url: string;
    body?: string | null;
  }> = [],
): GithubWriteRunner & { createdIssues: Array<{ title: string; number: number }> } {
  let nextNumber = 5000;
  const createdIssues: Array<{ title: string; number: number }> = [];
  return {
    createdIssues,
    get(_path: string): unknown {
      // Return the mocked list of existing issues for any listing call.
      return existingIssues;
    },
    post(_path: string, payload: unknown): unknown {
      const p = payload as { title: string; body?: string };
      const number = nextNumber++;
      createdIssues.push({ title: p.title, number });
      return {
        number,
        html_url: `https://github.com/nalfeo/Crawler/issues/${number}`,
        title: p.title,
      };
    },
  };
}

/** Build a synthetic existing-issue object with the standard `Node:` marker in the body. */
function makeExistingIssue(
  nodeId: string,
  title: string,
  number: number,
): { number: number; title: string; html_url: string; body: string } {
  return {
    number,
    title,
    html_url: `https://github.com/nalfeo/Crawler/issues/${number}`,
    body: `Parent: #1264\nNode: \`${nodeId}\`\nLane: \`test\`\nPersona: Test\n\n## Objective\nTest`,
  };
}

describe('materializeChildIssues — dry-run', () => {
  it('returns dry-run outcomes matching buildMaterializationPlan without any GitHub calls', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    const runner = makeMockWriteRunner();
    const result = materializeChildIssues(state, runner, { dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.created_count).toBe(0);
    expect(result.existing_count).toBe(0);
    expect(result.outcomes).toHaveLength(plan.length);
    expect(result.outcomes.every((o) => o.status === 'dry-run')).toBe(true);
    expect(result.outcomes.every((o) => o.issue_number === null)).toBe(true);
    expect(result.outcomes.map((o) => o.node_id)).toEqual(plan.map((p) => p.node_id));

    // No GitHub API calls in dry-run.
    expect(runner.createdIssues).toHaveLength(0);
  });

  it('returns empty outcomes when all nodes already have issues (dry-run)', () => {
    const state = stateWithAllIssues();
    const runner = makeMockWriteRunner();
    const result = materializeChildIssues(state, runner, { dryRun: true });

    expect(result.outcomes).toHaveLength(0);
    expect(result.dry_run).toBe(true);
    expect(runner.createdIssues).toHaveLength(0);
  });

  it('dry-run outcomes preserve node_id → title mapping from the plan', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    const runner = makeMockWriteRunner();
    const result = materializeChildIssues(state, runner, { dryRun: true });

    for (let i = 0; i < plan.length; i++) {
      expect(result.outcomes[i]?.node_id).toBe(plan[i]?.node_id);
      expect(result.outcomes[i]?.title).toBe(plan[i]?.title);
    }
  });
});

describe('materializeChildIssues — confirm', () => {
  it('creates new issues for all planned packets and records counts', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    const runner = makeMockWriteRunner();
    const result = materializeChildIssues(state, runner, { dryRun: false });

    expect(result.dry_run).toBe(false);
    expect(result.created_count).toBe(plan.length);
    expect(result.existing_count).toBe(0);
    expect(result.outcomes).toHaveLength(plan.length);
    expect(result.outcomes.every((o) => o.status === 'created')).toBe(true);
    expect(runner.createdIssues).toHaveLength(plan.length);
  });

  it('reports existing issues as existing and does not create duplicates', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    // Pre-populate all planned issues as if they already exist on GitHub (with stable Node: markers).
    const existingIssues = plan.map((p, i) => makeExistingIssue(p.node_id, p.title, 8000 + i));
    const runner = makeMockWriteRunner(existingIssues);
    const result = materializeChildIssues(state, runner, { dryRun: false });

    expect(result.created_count).toBe(0);
    expect(result.existing_count).toBe(plan.length);
    expect(result.outcomes.every((o) => o.status === 'existing')).toBe(true);
    // No new issues should be created.
    expect(runner.createdIssues).toHaveLength(0);
  });

  it('matches existing issues by node_id body marker even when title has changed', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    // Simulate a title edit: title does not match but node_id marker is present.
    const existingIssues = plan.map((p, i) =>
      makeExistingIssue(p.node_id, `EDITED: ${p.title}`, 8100 + i),
    );
    const runner = makeMockWriteRunner(existingIssues);
    const result = materializeChildIssues(state, runner, { dryRun: false });

    // All should be found via the body marker despite the title mismatch.
    expect(result.created_count).toBe(0);
    expect(result.existing_count).toBe(plan.length);
    expect(runner.createdIssues).toHaveLength(0);
  });

  it('creates only missing issues when some already exist', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    // Pre-populate only the first half as existing.
    const half = Math.floor(plan.length / 2);
    const existingIssues = plan
      .slice(0, half)
      .map((p, i) => makeExistingIssue(p.node_id, p.title, 8000 + i));
    const runner = makeMockWriteRunner(existingIssues);
    const result = materializeChildIssues(state, runner, { dryRun: false });

    expect(result.existing_count).toBe(half);
    expect(result.created_count).toBe(plan.length - half);
    expect(result.outcomes).toHaveLength(plan.length);
  });

  it('returns zero outcomes when all nodes already have state-recorded issues', () => {
    const state = stateWithAllIssues();
    const runner = makeMockWriteRunner();
    const result = materializeChildIssues(state, runner, { dryRun: false });

    expect(result.outcomes).toHaveLength(0);
    expect(result.created_count).toBe(0);
    expect(result.existing_count).toBe(0);
    expect(runner.createdIssues).toHaveLength(0);
  });

  it('all created outcomes have non-null issue_number and issue_url', () => {
    const state = stateWithNoIssues();
    const runner = makeMockWriteRunner();
    const result = materializeChildIssues(state, runner, { dryRun: false });

    for (const outcome of result.outcomes) {
      expect(outcome.issue_number).not.toBeNull();
      expect(outcome.issue_url).not.toBeNull();
      expect(typeof outcome.issue_number).toBe('number');
      expect(typeof outcome.issue_url).toBe('string');
    }
  });
});

describe('patchEpicStateIssues', () => {
  let tmpDir: string;
  let epicDir: string;
  let stateFilePath: string;

  beforeEach(() => {
    // Write a temporary copy of the state file so tests don't mutate the real one.
    tmpDir = tmpdir();
    epicDir = join(tmpDir, `epic-materialize-test-${Date.now()}`);
    mkdirSync(epicDir, { recursive: true });
    stateFilePath = join(epicDir, 'epic-state.json');
    const original = readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8');
    writeFileSync(stateFilePath, original, 'utf8');
  });

  afterEach(() => {
    rmSync(epicDir, { recursive: true, force: true });
  });

  it('updates nodes in epic-state.json with the provided issue map', () => {
    const issueMap = new Map([
      ['slice:B1', { number: 6001, url: 'https://github.com/nalfeo/Crawler/issues/6001' }],
      ['slice:B2', { number: 6002, url: 'https://github.com/nalfeo/Crawler/issues/6002' }],
    ]);

    // Use a fake repoRoot pointing at our temp dir structure.
    const fakeRepoRoot = tmpDir;

    // Build a minimal fake repoRoot→epicId path by writing state to expected path.
    const fakeEpicPath = join(tmpDir, 'docs', 'knowledge', 'epics', 'test-epic');
    mkdirSync(fakeEpicPath, { recursive: true });
    const fakeStateFile = join(fakeEpicPath, 'epic-state.json');
    const original = readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8');
    writeFileSync(fakeStateFile, original, 'utf8');

    patchEpicStateIssues(fakeRepoRoot, 'test-epic', issueMap);

    const patched = JSON.parse(readFileSync(fakeStateFile, 'utf8')) as EpicState;
    const b1 = patched.nodes.find((n) => n.node_id === 'slice:B1');
    const b2 = patched.nodes.find((n) => n.node_id === 'slice:B2');
    expect(b1?.github.issue?.number).toBe(6001);
    expect(b2?.github.issue?.number).toBe(6002);
  });

  it('does not overwrite an already-set issue field', () => {
    // slice:A1 already has issue 1279 in the committed state.
    const issueMap = new Map([
      ['slice:A1', { number: 9999, url: 'https://github.com/nalfeo/Crawler/issues/9999' }],
    ]);
    const fakeEpicPath = join(tmpDir, 'docs', 'knowledge', 'epics', 'test-epic-2');
    mkdirSync(fakeEpicPath, { recursive: true });
    const fakeStateFile = join(fakeEpicPath, 'epic-state.json');
    const original = readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8');
    writeFileSync(fakeStateFile, original, 'utf8');

    patchEpicStateIssues(tmpDir, 'test-epic-2', issueMap);

    const patched = JSON.parse(readFileSync(fakeStateFile, 'utf8')) as EpicState;
    const a1 = patched.nodes.find((n) => n.node_id === 'slice:A1');
    // The existing 1279 must be preserved.
    expect(a1?.github.issue?.number).toBe(1279);
  });

  it('is a no-op when issueMap is empty', () => {
    const fakeEpicPath = join(tmpDir, 'docs', 'knowledge', 'epics', 'test-epic-3');
    mkdirSync(fakeEpicPath, { recursive: true });
    const fakeStateFile = join(fakeEpicPath, 'epic-state.json');
    const original = readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8');
    writeFileSync(fakeStateFile, original, 'utf8');

    const statBefore = readFileSync(fakeStateFile, 'utf8');
    patchEpicStateIssues(tmpDir, 'test-epic-3', new Map());
    // File should be untouched (not even read when map is empty).
    expect(readFileSync(fakeStateFile, 'utf8')).toBe(statBefore);
  });

  it('writes valid JSON with trailing newline', () => {
    const fakeEpicPath = join(tmpDir, 'docs', 'knowledge', 'epics', 'test-epic-4');
    mkdirSync(fakeEpicPath, { recursive: true });
    const fakeStateFile = join(fakeEpicPath, 'epic-state.json');
    const original = readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8');
    writeFileSync(fakeStateFile, original, 'utf8');

    patchEpicStateIssues(
      tmpDir,
      'test-epic-4',
      new Map([
        ['slice:B1', { number: 7001, url: 'https://github.com/nalfeo/Crawler/issues/7001' }],
      ]),
    );

    const content = readFileSync(fakeStateFile, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe('buildMaterializationPlan — idempotency invariants', () => {
  it('excludes slice:A0 from the plan regardless of its issue state', () => {
    const state = stateWithNoIssues();
    const plan = buildMaterializationPlan(state);
    expect(plan.every((p) => p.node_id !== 'slice:A0')).toBe(true);
  });

  it('produces an empty plan when all non-A0 nodes have issues', () => {
    const state = stateWithAllIssues();
    expect(buildMaterializationPlan(state)).toHaveLength(0);
  });

  it('plan count equals number of nodes without issues (excluding A0)', () => {
    const state = structuredClone(STATE);
    const withoutIssue = state.nodes.filter(
      (n) => n.node_id !== 'slice:A0' && n.github.issue === null,
    );
    const plan = buildMaterializationPlan(state);
    expect(plan).toHaveLength(withoutIssue.length);
  });
});
