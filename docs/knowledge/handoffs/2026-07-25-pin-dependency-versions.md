# Handoff: Pin Dependency Versions to Prevent Microsoft Proxy Quarantine Churn

**Date:** 2026-07-25
**Session slug:** pin-dependency-versions
**PR:** Closes #1938
**Apples:** 🍎🍎🍎 estimated / 🍎🍎🍎 actual — exact

## Systems touched

tooling, ci

## Summary

Converts all direct dependencies, devDependencies, and overrides in `package.json`
from semver ranges (`^`, `~`) to exact version strings. Adds a `.npmrc` with
`save-exact=true` so future `npm install` commands default to exact pinning. Adds
a deterministic CI guard (`check-exact-deps.mjs`) that rejects any PR introducing
a non-exact version specifier.

## Motivation

Microsoft's internal npm proxy enforces a seven-day quarantine before newly
published packages are mirrored. An unrelated `npm install --package-lock-only`
can silently advance a direct dependency to the latest matching release before
the proxy mirrors it. The next `npm ci` then fails with a false 404, blocking
local work and open PRs for days. Exact pinning prevents any direct dependency
from advancing without an explicit, reviewable edit to `package.json`.

## Files changed

| File                                               | Change                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                     | All 35 direct dep/devDep/override entries changed from `^`/`~` ranges to exact versions                             |
| `package-lock.json`                                | Lockfile metadata synced — root package entry now mirrors exact versions                                            |
| `.npmrc`                                           | New: `save-exact=true` — ensures future installs write exact versions                                               |
| `scripts/agent/security/check-exact-deps.mjs`      | New: deterministic validator using strict exact-semver regex; checks deps/devDeps/optionalDeps and nested overrides |
| `scripts/agent/security/check-exact-deps.test.mjs` | New: 21 unit tests covering all major specifier forms                                                               |
| `package.json` (scripts)                           | Added `security:exact-deps` script; wired into `security:check`                                                     |
| `.github/workflows/ci.yml`                         | Added blocking `Exact dependency versions` step in `check-lightweight` job                                          |
| `docs/guides/dependency-upgrades.md`               | New: documents the intentional upgrade procedure, quarantine wait, and exemption process                            |

## Key design decisions

**Why exact semver regex not prefix-check:** The initial plan proposed checking whether
a version string starts with `^`, `~`, etc. The plan review (gpt-5.4) flagged this
correctly: prefix-checks miss `1.x`, `latest`, `1.2 - 2.0`, OR ranges, and nested
overrides. The final implementation validates with `EXACT_SEMVER_RE` and rejects
anything that doesn't match three-part semver, which is a more principled approach.

**Why `security:exact-deps` as a dedicated script:** The plan originally proposed
adding the check only as a CI step. The plan reviewer noted `security:check` is also
invoked by the merge-train validator. Adding `security:exact-deps` to `security:check`
ensures the guard runs in both paths.

**Blocking not advisory:** A non-exact dep is immediately actionable (pin to the
current lockfile version) with no false-positive risk, so it belongs in the blocking
CI path.

**Goal scope:** The guard prevents _direct_ dependency drift. Transitive dependency
versions remain controlled by `package-lock.json`; the exact-deps policy does not
attempt to also guard transitives.

## Verification

- `node --test scripts/agent/security/check-exact-deps.test.mjs` — 21/21 pass
- `node scripts/agent/security/check-exact-deps.mjs` — clean on current `package.json`
- `npm install --package-lock-only` — lockfile metadata updated; no remaining ranges

## Review ledger

`docs/knowledge/review-ledgers/2026-07-25-pin-dependency-versions.review-ledger.json`
— 3🍎, plan_review (gpt-5.4, 5 concerns, 5 resolved, minor divergence) + code_review
(claude-sonnet-4.6, 1 concern [incomplete ledger], 1 resolved, clean).
