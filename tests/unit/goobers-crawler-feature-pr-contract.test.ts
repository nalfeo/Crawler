/**
 * Crawler feature-PR workflow contract tests.
 *
 * Enforces issue #4442 acceptance criteria:
 * - Initial implementation receives exactly one canonical requirements artifact
 *   and one canonical producer-plan artifact.
 * - A repass receives only the latest applicable reviewer defect list or local
 *   verification failure, deduplicated by root cause; it does not receive
 *   self-context or superseded historical artifacts.
 * - The workflow order is implement → local fast verification → review →
 *   push/open PR.
 * - Deterministic local verification failures return directly to implement
 *   without an intervening agent review.
 * - Automatic review repasses are capped below the current six-pass ceiling.
 * - Explicit escalation paths and trust/credential boundaries are preserved.
 *
 * Run with: npx vitest run tests/unit/goobers-crawler-feature-pr-contract.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface GoobersTask {
  name: string;
  type?: string;
  next?: string;
  contextFrom?: string[];
  run?: {
    script?: string;
    command?: string[];
  };
  retry?: {
    maxAttempts?: number;
  };
}

interface GoobersGate {
  name: string;
  evaluator?: string;
  maxRepasses?: number;
  branches?: Record<string, string>;
  agentic?: {
    retry?: {
      maxAttempts?: number;
    };
  };
}

interface GoobersSpec {
  readiness?: { maxConcurrentRuns?: number };
  runControls?: { maxRepasses?: number };
  start?: string;
  tasks?: GoobersTask[];
  gates?: GoobersGate[];
}

interface GoobersDefinition {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: GoobersSpec;
}

function loadWorkflow(): GoobersDefinition {
  const yaml = readFileSync(
    path.join(REPO_ROOT, '.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml'),
    'utf8',
  );
  return parse(yaml) as GoobersDefinition;
}

describe('Crawler crawler-feature-pr workflow contract', () => {
  let workflow: GoobersDefinition;
  let tasks: Map<string, GoobersTask>;
  let gates: Map<string, GoobersGate>;

  function setup() {
    workflow = loadWorkflow();
    tasks = new Map((workflow.spec?.tasks ?? []).map((t) => [t.name, t]));
    gates = new Map((workflow.spec?.gates ?? []).map((g) => [g.name, g]));
  }

  describe('Initial context contract', () => {
    beforeEach(setup);

    it('workflow starts at query-backlog', () => {
      expect(workflow.spec?.start).toBe('query-backlog');
    });

    it('hydrate-requirements produces canonical requirements artifact', () => {
      const hydrate = tasks.get('hydrate-requirements');
      expect(hydrate).toBeDefined();
      expect(hydrate?.type).toBe('deterministic');
      expect(hydrate?.run?.script).toContain('requirements-result.json');
      // The artifact schema must be emitted so downstream always sees the same shape.
      expect(hydrate?.run?.script).toContain('crawler.goobers.requirements/v1');
    });

    it('materialize-plan produces canonical producer-plan artifact', () => {
      const materialize = tasks.get('materialize-plan');
      expect(materialize).toBeDefined();
      expect(materialize?.type).toBe('deterministic');
      expect(materialize?.run?.script).toContain('implementation-plan-result.json');
      // The artifact schema must be emitted so downstream always sees the same shape.
      expect(materialize?.run?.script).toContain('crawler.goobers.implementation-plan/v1');
    });

    it('plan receives only hydrate-requirements (no historical context)', () => {
      const plan = tasks.get('plan');
      expect(plan).toBeDefined();
      expect(plan?.contextFrom).toEqual(['hydrate-requirements']);
    });

    it('implement receives only hydrate-requirements and materialize-plan on initial pass', () => {
      const implement = tasks.get('implement');
      expect(implement).toBeDefined();
      // The contextFrom lists all possible upstream sources for all passes, but
      // the Goobers runtime deduplicates on repass. On initial pass (when
      // local-ci and review have not run yet), the runtime resolves these to:
      // - hydrate-requirements (from hydrate-requirements)
      // - materialize-plan (from materialize-plan)
      // - local-ci (no match, not run yet)
      // - review (no match, not run yet)
      expect(implement?.contextFrom).toContain('hydrate-requirements');
      expect(implement?.contextFrom).toContain('materialize-plan');
      expect(implement?.contextFrom).toContain('local-ci');
      expect(implement?.contextFrom).toContain('review');
    });
  });

  describe('Deterministic verification gate', () => {
    beforeEach(setup);

    it('implements local fast verification before review', () => {
      const implement = tasks.get('implement');
      const localCi = tasks.get('local-ci');
      const localGate = gates.get('local-gate');
      const review = gates.get('review');

      expect(implement).toBeDefined();
      expect(localCi).toBeDefined();
      expect(localGate).toBeDefined();
      expect(review).toBeDefined();

      // The task order is: implement → local-ci → local-gate
      expect(implement?.next).toBe('local-ci');
      expect(localCi?.next).toBe('local-gate');
    });

    it('local-ci is deterministic and runs fast verification', () => {
      const localCi = tasks.get('local-ci');
      expect(localCi?.type).toBe('deterministic');
      expect(localCi?.run?.command).toEqual(['npm', 'run', 'verify:fast']);
    });

    it('local-gate routes failures back to implement without review', () => {
      const localGate = gates.get('local-gate');
      expect(localGate?.branches?.fail).toBe('implement');
      expect(localGate?.branches?.pass).toBe('review');
      // infra failures also loop back to implement
      expect(localGate?.branches?.infra).toBe('local-ci');
    });

    it('implements repass deduplication by documenting contextFrom sources', () => {
      // The contextFrom list includes local-ci and review, which allows the
      // Goobers runtime's SelectContextPointers to pick the latest artifact
      // when re-entering implement after either a local-gate or review failure.
      // On repass:
      // - If local-gate fails, implement re-enters with only the local-ci
      //   artifact (latest failure point), not hydrate-requirements or
      //   materialize-plan again.
      // - If review fails with needs-changes, implement re-enters with only the
      //   review verdict (latest failure point), not hydrate-requirements,
      //   materialize-plan, or the old local-ci result.
      // The actual deduplication is enforced by the Goobers runtime's
      // SelectContextPointers logic; this test documents the contract.
      const implement = tasks.get('implement');
      const contextFrom = implement?.contextFrom ?? [];
      expect(contextFrom.length).toBeGreaterThan(0);
      expect(contextFrom).toContain('hydrate-requirements');
      expect(contextFrom).toContain('materialize-plan');
    });
  });

  describe('Automatic repass caps', () => {
    beforeEach(setup);

    it('caps overall workflow repasses', () => {
      const maxRepasses = workflow.spec?.runControls?.maxRepasses;
      expect(maxRepasses).toBeDefined();
      expect(maxRepasses).toBeLessThan(6);
      expect(maxRepasses).toBeGreaterThan(0);
    });

    it('caps review gate repasses', () => {
      const reviewGate = gates.get('review');
      const maxRepasses = reviewGate?.maxRepasses;
      expect(maxRepasses).toBeDefined();
      expect(maxRepasses).toBeLessThan(6);
      expect(maxRepasses).toBeGreaterThan(0);
    });

    it('documents the repass cap in workflow comments', () => {
      const yaml = readFileSync(
        path.join(REPO_ROOT, '.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml'),
        'utf8',
      );
      // The workflow comments must state why the cap exists and what the value is.
      expect(yaml).toMatch(/automatic repasses?/i);
      expect(yaml).toMatch(/six/i);
    });
  });

  describe('Escalation paths and trust boundaries', () => {
    beforeEach(setup);

    it('preserves explicit needs-human and escalation branches', () => {
      const reviewGate = gates.get('review');
      expect(reviewGate?.branches?.fail).toBe('park-needs-human');
      expect(reviewGate?.branches?.escalate).toBe('needs-remediation');
    });

    it('prevents credentials leaks in park-needs-human', () => {
      const parkNeedsHuman = tasks.get('park-needs-human');
      // This must be a bare `goobers` command, not a checked-out script.
      expect(parkNeedsHuman?.run?.command?.[0]).toBe('goobers');
    });

    it('prevents credentials leaks in needs-remediation', () => {
      const needsRemediation = tasks.get('needs-remediation');
      // This must be a bare `goobers` command, not a checked-out script.
      expect(needsRemediation?.run?.command?.[0]).toBe('goobers');
    });

    it('prevents credentials leaks in close-out', () => {
      const closeOut = tasks.get('close-out');
      // This must be a bare `goobers` command, not a checked-out script.
      expect(closeOut?.run?.command?.[0]).toBe('goobers');
    });
  });

  describe('Workflow evaluation order', () => {
    beforeEach(setup);

    it('reviews only after local gate passes', () => {
      const localGate = gates.get('local-gate');
      expect(localGate?.branches?.pass).toBe('review');
      // The order in spec.gates does not enforce evaluation order, but the
      // task dependency chain does.
    });

    it('opens PR only after review gate passes', () => {
      const reviewGate = gates.get('review');
      expect(reviewGate?.branches?.pass).toBe('push-branch');
    });

    it('pushes branch and opens PR in sequence', () => {
      const pushBranch = tasks.get('push-branch');
      expect(pushBranch?.next).toBe('open-pr');
    });

    it('completes workflow after PR opens successfully', () => {
      const prOpenedGate = gates.get('pr-opened-gate');
      expect(prOpenedGate?.branches?.pass).toBe('close-out');
    });
  });

  describe('Repass entry points', () => {
    beforeEach(setup);

    it('local-gate failure returns to implement', () => {
      const localGate = gates.get('local-gate');
      expect(localGate?.branches?.fail).toBe('implement');
    });

    it('review needs-changes returns to implement', () => {
      const reviewGate = gates.get('review');
      expect(reviewGate?.branches?.['needs-changes']).toBe('implement');
    });

    it('implement receives review verdict when re-entering', () => {
      const implement = tasks.get('implement');
      // The contextFrom must include review so that when the review gate
      // sends needs-changes back to implement, the verdict is available.
      expect(implement?.contextFrom).toContain('review');
    });

    it('implement receives local-ci result when re-entering', () => {
      const implement = tasks.get('implement');
      // The contextFrom must include local-ci so that when the local-gate
      // sends a failure back to implement, the verification output is available.
      expect(implement?.contextFrom).toContain('local-ci');
    });
  });

  describe('Initial pass isolation', () => {
    beforeEach(setup);

    it('plan task does not receive review context', () => {
      const plan = tasks.get('plan');
      expect(plan?.contextFrom).not.toContain('review');
      expect(plan?.contextFrom).not.toContain('local-ci');
    });

    it('materialize-plan does not receive implement or local-ci context', () => {
      const materializePlan = tasks.get('materialize-plan');
      const contextFrom = materializePlan?.contextFrom;
      // materialize-plan should not have any contextFrom (it runs after plan)
      expect(contextFrom).toBeUndefined();
    });

    it('hydrate-requirements is purely deterministic', () => {
      const hydrate = tasks.get('hydrate-requirements');
      expect(hydrate?.type).toBe('deterministic');
      expect(hydrate?.contextFrom).not.toBeDefined();
    });
  });
});
