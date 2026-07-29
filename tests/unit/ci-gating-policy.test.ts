import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the headless and coverage job gating policy in ci.yml.
 *
 * Key requirements from nalfeo/Crawler#1696:
 *   - PR headless jobs start only when `sim_touched=true`.
 *   - PR coverage jobs start only when `coverage_touched=true`.
 *   - Classifier failure cannot silently skip either gate (changes job failure
 *     propagates through the merge gate check).
 *   - Main-push and scheduled behavior remains a documented backstop
 *     (jobs run unconditionally on non-PR events).
 *   - Merge gate accepts intentional scope skips (sim_touched=false) and still
 *     rejects failed scope detection (missing sim_touched with a skip).
 *
 * This test parses the real ci.yml YAML (not a re-implementation) and asserts the
 * structural properties that enforce these requirements, so a future edit that
 * weakens a condition is caught immediately.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowJob {
  if?: string | boolean;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: Array<{ run?: string; id?: string; name?: string }>;
}

interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
}

function loadCiWorkflow(): WorkflowDoc {
  const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  return parse(raw) as WorkflowDoc;
}

function getJob(doc: WorkflowDoc, name: string): WorkflowJob {
  const job = doc.jobs[name];
  if (!job) throw new Error(`job "${name}" not found in ci.yml`);
  return job;
}

function getJobIf(doc: WorkflowDoc, name: string): string {
  return String(getJob(doc, name).if ?? '').trim();
}

function getMergeGateScript(doc: WorkflowDoc): string {
  const job = getJob(doc, 'merge-gate');
  const script = job.steps?.find((s) => s.name === 'Check required jobs')?.run ?? '';
  if (!script) throw new Error('merge-gate "Check required jobs" step not found');
  return script;
}

describe('ci.yml headless and coverage gating policy', () => {
  it('parses ci.yml and finds required jobs', () => {
    const doc = loadCiWorkflow();
    expect(doc.jobs['changes']).toBeDefined();
    expect(doc.jobs['test-headless']).toBeDefined();
    expect(doc.jobs['ci-coverage']).toBeDefined();
    expect(doc.jobs['merge-gate']).toBeDefined();
  });

  // --- changes job outputs ---

  it('changes job exposes sim_touched output', () => {
    const doc = loadCiWorkflow();
    const outputs = getJob(doc, 'changes').outputs ?? {};
    expect(Object.keys(outputs)).toContain('sim_touched');
  });

  it('changes job exposes coverage_touched output', () => {
    const doc = loadCiWorkflow();
    const outputs = getJob(doc, 'changes').outputs ?? {};
    expect(Object.keys(outputs)).toContain('coverage_touched');
  });

  // --- test-headless gating ---

  it('test-headless skips on PR when sim_touched is not true', () => {
    const condition = getJobIf(loadCiWorkflow(), 'test-headless');
    // The condition must gate on sim_touched for pull_request events.
    // Logical structure: "(github.event_name != 'pull_request' || needs.changes.outputs.sim_touched == 'true')"
    // so that on non-PR events the job always runs as a backstop.
    expect(condition).toContain("sim_touched == 'true'");
    expect(condition).toContain("github.event_name != 'pull_request'");
  });

  it('test-headless runs on non-PR events regardless of sim_touched (backstop)', () => {
    const condition = getJobIf(loadCiWorkflow(), 'test-headless');
    // The PR-gate must be expressed as an OR with non-PR event check, not as a bare
    // sim_touched check, so main-push and schedule always run the gate.
    // Pattern: (github.event_name != 'pull_request' || needs.changes.outputs.sim_touched == 'true')
    expect(condition).toMatch(/github\.event_name\s*!=\s*'pull_request'/);
  });

  it('test-headless does NOT reference the old gameplay_safe condition', () => {
    // gameplay_safe was the previous gating mechanism; the new mechanism uses sim_touched.
    // Having both could cause confusion; this ensures the migration is complete.
    const condition = getJobIf(loadCiWorkflow(), 'test-headless');
    expect(condition).not.toContain('gameplay_safe');
  });

  it('test-headless still skips on art_only and docs_only', () => {
    const condition = getJobIf(loadCiWorkflow(), 'test-headless');
    expect(condition).toContain("art_only != 'true'");
    expect(condition).toContain("docs_only != 'true'");
  });

  // --- ci-coverage gating ---

  it('ci-coverage skips on PR only when coverage_touched is explicitly false (fail-closed)', () => {
    const condition = getJobIf(loadCiWorkflow(), 'ci-coverage');
    // Fail-closed: only an explicit 'false' skips coverage — a missing/blank value runs the job.
    // Pattern: (github.event_name != 'pull_request' || needs.changes.outputs.coverage_touched != 'false')
    expect(condition).toContain("coverage_touched != 'false'");
    expect(condition).toContain("github.event_name != 'pull_request'");
  });

  it('ci-coverage runs on non-PR events regardless of coverage_touched (backstop)', () => {
    const condition = getJobIf(loadCiWorkflow(), 'ci-coverage');
    expect(condition).toMatch(/github\.event_name\s*!=\s*'pull_request'/);
  });

  it('ci-coverage still skips on docs_only and sprites_only', () => {
    const condition = getJobIf(loadCiWorkflow(), 'ci-coverage');
    expect(condition).toContain("docs_only != 'true'");
    expect(condition).toContain("sprites_only != 'true'");
  });

  // --- merge gate headless check ---

  it('merge gate checks sim_touched when evaluating headless skip', () => {
    const script = getMergeGateScript(loadCiWorkflow());
    // The merge gate must reference sim_touched to validate intentional skips.
    expect(script).toContain('sim_touched');
  });

  it('merge gate rejects headless skip without sim_touched=false', () => {
    const script = getMergeGateScript(loadCiWorkflow());
    // Must have a conditional that allows skip only when sim_touched == false.
    // The merge gate should use an explicit variable pattern, not an inline subshell.
    expect(script).toContain('"$sim_touched" = "false"');
  });

  it('merge gate still checks changes job result (classifier failure must not pass)', () => {
    const script = getMergeGateScript(loadCiWorkflow());
    // The "Change scope detection" check must be present to catch classifier failures.
    expect(script).toContain('Change scope detection');
    expect(script).toContain('needs.changes.result');
  });

  it('merge-gate includes test-headless in its needs array', () => {
    const doc = loadCiWorkflow();
    const needs = getJob(doc, 'merge-gate').needs;
    const needsArray = Array.isArray(needs) ? needs : [needs];
    expect(needsArray).toContain('test-headless');
  });

  it('merge-gate includes changes in its needs array', () => {
    const doc = loadCiWorkflow();
    const needs = getJob(doc, 'merge-gate').needs;
    const needsArray = Array.isArray(needs) ? needs : [needs];
    expect(needsArray).toContain('changes');
  });

  it('merge-gate includes set-piece reachability in its needs array', () => {
    const doc = loadCiWorkflow();
    const needs = getJob(doc, 'merge-gate').needs;
    const needsArray = Array.isArray(needs) ? needs : [needs];
    expect(needsArray).toContain('set-piece-reachability');
  });
});
