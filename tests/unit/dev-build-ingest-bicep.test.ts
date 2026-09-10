import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression test for the "in-game Report Issue flow silently ships without
// GitHub issue-write credentials" bug (nalfeo/Crawler#4033): a fresh or
// repeated Bicep deployment of the dev-build-ingest Function used to succeed
// even when the CRAWLER_CI_PAT app setting was never supplied, so the
// Function only failed (HTTP 500 `missing required configuration:
// CRAWLER_CI_PAT`) the first time a player actually reported an issue. This
// test parses infra/dev-build-ingest.bicep as text (no `az`/Bicep CLI
// dependency, so it runs fast and deterministically in `npm run test:unit`)
// and fails if the required-secure-parameter-to-Function-app-setting wiring
// is removed, defaulted, or renamed.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadBicep(): string {
  return readFileSync(path.join(REPO_ROOT, 'infra', 'dev-build-ingest.bicep'), 'utf8');
}

describe('dev-build-ingest.bicep GitHub credential wiring', () => {
  it('declares githubCiPat as a @secure() parameter with no default value', () => {
    const bicep = loadBicep();
    // Match the `@secure()` decorator directly followed (allowing an
    // intervening `@minLength(...)` and/or `@description(...)` decorator) by
    // a `param githubCiPat <type>` declaration, capturing anything after the
    // type so we can assert there is no default-value assignment.
    const paramMatch = bicep.match(
      /@secure\(\)\s*(?:@minLength\(\d+\)\s*)?(?:@description\((?:[^()]|\([^()]*\))*\)\s*)?param githubCiPat (\w+)([^\n]*)/,
    );
    expect(
      paramMatch,
      'expected a @secure() param named githubCiPat in dev-build-ingest.bicep',
    ).not.toBeNull();
    expect(paramMatch?.[1]).toBe('string');
    const trailing = paramMatch?.[2]?.trim() ?? '';
    expect(
      trailing,
      'githubCiPat must not have a default value — a default would let a deployment silently omit the GitHub credential',
    ).toBe('');
  });

  it('rejects an empty-string githubCiPat, not just an omitted one', () => {
    // A deployment can supply the parameter while still passing an empty
    // string (e.g. an unset GitHub Actions secret expands to ""), which
    // `param githubCiPat string` alone would accept — recreating the exact
    // silent-breakage bug this parameter exists to prevent. `@minLength(1)`
    // makes ARM/Bicep reject that at deploy time too.
    const bicep = loadBicep();
    const decoratorBlock = bicep.slice(
      bicep.indexOf('@secure()'),
      bicep.indexOf('param githubCiPat'),
    );
    expect(
      /@minLength\(1\)/.test(decoratorBlock),
      'expected @minLength(1) decorating the githubCiPat param so an empty-string value fails deployment, not just an omitted one',
    ).toBe(true);
  });

  it('wires githubCiPat into the CRAWLER_CI_PAT Function app setting', () => {
    const bicep = loadBicep();
    const settingMatch = bicep.match(/\{\s*name:\s*'CRAWLER_CI_PAT'\s*value:\s*([^\n}]+?)\s*\}/);
    expect(
      settingMatch,
      'expected a CRAWLER_CI_PAT appSettings entry in dev-build-ingest.bicep',
    ).not.toBeNull();
    expect(settingMatch?.[1]?.trim()).toBe('githubCiPat');
  });

  it('does not declare any other unused/default GitHub-PAT-shaped parameter as a decoy', () => {
    const bicep = loadBicep();
    // Guard against a future edit that adds a second, differently-named
    // secure param wired to CRAWLER_CI_PAT while leaving githubCiPat behind
    // as dead code with a default — only one param should feed the setting.
    const settingMatches = [
      ...bicep.matchAll(/name:\s*'CRAWLER_CI_PAT'\s*value:\s*([^\n}]+?)\s*\}/g),
    ];
    expect(settingMatches).toHaveLength(1);
  });
});
