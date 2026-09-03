import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SKILL = readFileSync('.github/skills/run-bundle-analysis/SKILL.md', 'utf8');

describe('run-bundle-analysis skill contract', () => {
  it('is discoverable whenever run-bundle evidence is available', () => {
    expect(SKILL).toContain('name: run-bundle-analysis');
    expect(SKILL).toMatch(/Use whenever a bundle\.json\s+path or run-bundle URL is available/);
    expect(SKILL).toContain('even when the request does not explicitly ask for bundle analysis');
    expect(SKILL).toContain('Do not diagnose the reported');
  });

  it('parses every bundle channel defensively without executing content', () => {
    expect(SKILL).toContain('`meta` is an object');
    expect(SKILL).toContain('`runStats` is an object');
    expect(SKILL).toContain('`recorderJsonl` is a string');
    expect(SKILL).toContain('`logs` is an array of strings');
    expect(SKILL).toContain('Never import, evaluate, source, or execute');
    expect(SKILL).toContain('A missing optional field means `not recorded`, not zero');
  });

  it('requires evidence-backed reasoning and bounded reporting', () => {
    expect(SKILL).toContain('**Observed**');
    expect(SKILL).toContain('**Derived**');
    expect(SKILL).toContain('**Inferred**');
    expect(SKILL).toContain('**Unknown**');
    expect(SKILL).toContain('Telemetry gaps');
    expect(SKILL).toContain('Next verification');
    expect(SKILL).toContain('Never reproduce a signed query string');
    expect(SKILL).toContain('One run can reproduce a bug');
  });

  it('reports unavailable bundles instead of silently discarding them', () => {
    expect(SKILL).toContain('report `bundle unavailable`');
    expect(SKILL).toContain('Never silently');
    expect(SKILL).toContain('never describe an unavailable bundle as clean');
  });
});
