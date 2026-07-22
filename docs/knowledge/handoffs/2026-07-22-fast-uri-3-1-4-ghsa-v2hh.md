# Session Handoff: Patch fast-uri to 3.1.4 (GHSA-v2hh-gcrm-f6hx)

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci

## Apples

1🍎 — single transitive lockfile bump, no source/gameplay change. Deps-only
diff; exempt from the review-ledger requirement per
`docs/agent-os/policies/review-harness-policy.md`.

## What Was Done

Bumped the transitive `fast-uri` lockfile entry from `3.1.3` to `3.1.4` to fix
[GHSA-v2hh-gcrm-f6hx](https://github.com/fastify/fast-uri/security/advisories/GHSA-v2hh-gcrm-f6hx)
(host confusion via a literal backslash authority delimiter, CVE-2026-16221),
a high-severity advisory affecting `fast-uri < 3.1.4` on the 3.x line. `main`
locked `3.1.3`, which is vulnerable; `3.1.4` is the official fixed 3.x
release. All in-repo constraints on `fast-uri` are `^3.0.0`/`^3.0.1`
(pulled in transitively via `ajv` / `fast-json-stringify` / Stryker), so
`3.1.4` is admitted without any other lockfile or `package.json` changes.
`fastify` itself (`^5.8.5`) was left untouched — this advisory doesn't touch
Fastify's own version.

### Why this needed GitHub-hosted verification, not local

This session's sandbox resolves npm through a corporate proxy/mirror
(`packagefeedproxy.microsoft.io`), which had not yet mirrored `fast-uri@3.1.4`
(returns a hard `404` from the feed, not a TLS/network block — confirmed by
`npm view fast-uri versions` omitting `3.1.4`/`4.1.1`/`2.4.3` entirely, all
three of which are the advisory's fixed versions). Direct requests to
`registry.npmjs.org` also fail from this sandbox (`ERR_SSL_TLS_ALERT_HANDSHAKE_FAILURE`).

Because of that, the exact `resolved`/`integrity` pair for `fast-uri@3.1.4`
was **not** fabricated or copied from an unverified single source. It was
cross-corroborated from two independent, unrelated public repositories that
had already picked up the same npm-published tarball via
`registry.npmjs.org` (`angular/angular` and `taradix/taramux`, fetched via
GitHub's code-search + contents API) — both show the identical:

```
"resolved": "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.4.tgz",
"integrity": "sha512-8JnbkQ4juDyvYs4mgFGQqg4yCYtFDtUtmp2QIQq11ZZe5CFQ5wcqm1rqDgAh/QdMySuBnPzMUiJUNZG5N/AiQw==",
```

npm's sha512 integrity is a content hash of the tarball, so agreement across
two unrelated repos is strong evidence this is the authentic public-registry
value (not a mirror/proxy substitution) — same verification spirit as the
`npm pack` + local-hash approach used in the prior `fast-uri` fix (PR #1758),
just via cross-repo corroboration instead of a local download, since the
local sandbox categorically cannot reach the tarball for this version.

`npm ci` was attempted locally and failed **only** on
`fast-uri@3.1.4` with the proxy's `404` (every other package in the lockfile
installed cleanly), confirming the failure is a local mirror-lag artifact,
not a problem with the lockfile edit. GitHub Actions' `ci.yml` job uses
`actions/setup-node@v4` with the default (public) npm registry and has real
internet access, so `npm ci` there resolves `fast-uri@3.1.4` from the real
registry. The PR's `dependencies_touched` scope flag makes `ci.yml` run its
`npm audit --audit-level=high` step automatically.

## Verification

- `node -e "JSON.parse(...)"` — package-lock.json remains valid JSON.
- `node scripts/agent/review/pr-prereq-check.mjs` — passed locally;
  confirmed deps-only diff is exempt from the review-ledger requirement.
- `npm ci` (local, corporate-proxy sandbox) — fails only on the single
  `fast-uri@3.1.4` tarball (proxy 404, not yet mirrored); every other
  package resolved and installed successfully, isolating the gap to local
  mirror lag rather than the change itself.
- CI (`ci.yml`, GitHub-hosted, real npm registry) is the authoritative
  verification for `npm ci` / `npm audit --audit-level=high` on this PR —
  see the PR checks for the actual run.

## Scope

Diff is limited to `package-lock.json` (single `fast-uri` entry: version +
`resolved` + `integrity`, 6 lines) plus this handoff. No `package.json`,
Fastify version, sweep workflow, or other PR's files were touched.
