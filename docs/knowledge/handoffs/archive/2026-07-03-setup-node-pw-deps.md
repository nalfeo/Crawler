# Session Handoff: Fix Playwright cache-hit gap in shared setup-node action

## Date

2026-07-03

## Persona(s) adopted

**Producer** — the task is CI/infra plumbing that touches a shared composite action
used by many workflows; Producer is the default for cross-cutting, multi-workflow
impact and coordinating the review/merge lifecycle.

## Routing verdict

✅ right persona — a single-file CI fix with repo-wide blast radius fits the
Producer's coordinate-and-ship remit.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1
Verdict: 🎯 Exact — a single-file, proven-pattern CI YAML change with no surprises.

Hello kitties: 1/5 = 0.20 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-setup-node-pw-deps.review-ledger.json`
Stages: none required at 1🍎 (the ledger records the tier only).
`npm run review:ledger -- validate <path>` → pass.

## What Was Done

Fixed a latent CI bug in the shared composite action
`.github/actions/setup-node/action.yml`. Its final step installed Playwright
browsers **and** OS-level system libraries in one command
(`npx playwright install chromium --with-deps`) but was gated entirely on a
Playwright-browser **cache miss** (`if: steps.pw-cache.outputs.cache-hit != 'true'`).

`actions/cache` (path `~/.cache/ms-playwright`) restores only the browser
**binaries** — it does not persist OS-level system libraries, and fresh runners
lack them. So on a cache **hit** the whole step was skipped, `--with-deps` never
ran, and the required OS libs were absent → Chromium could fail to launch in any
job using this action (notably the `test-e2e` "E2E Visual Regression" job).

Mirroring the proven fix from PR #715 (commit `93d90fe6`, which fixed the identical
class of bug in `copilot-setup-steps.yml`), the single cache-gated step was split
into two:

1. **Always-run** (no cache gate): `npx playwright install-deps chromium` — installs
   OS system deps on both cache hit and miss (fast, idempotent).
2. **Cache-miss-gated** (keeps `if: ...cache-hit != 'true'`): `npx playwright install
chromium` (without `--with-deps`) — preserves the browser-binary caching speedup.

Both steps retain `shell: bash` (required for composite-action `run:` steps — the
difference from #715's workflow-level fix, which does not need `shell:`). The
`pw-cache` `actions/cache@v4` step is unchanged. No node-version, cache keys, or
unrelated steps were touched.

## Runtime / real-artifact observation

Not a game-runtime/ECS change — this is CI infra, so the "real artifact" is the CI
run itself, not the game or a lab. The composite action is consumed by `ci.yml`,
whose blocking **`test-e2e` ("E2E Visual Regression", ci.yml:283)** job runs
`./.github/actions/setup-node` then `npx vitest run --project e2e`, which launches
Chromium via Playwright.

- **Before:** on a warm `pw-cache` (cache HIT), the install step was skipped, so OS
  libs were absent and Chromium launch was at risk.
- **After:** `install-deps chromium` runs unconditionally, so Chromium launches on
  both cache hit and miss.

Proof named in the PR: the PR's own `test-e2e` job (part of the aggregate `ci`
check) exercises the fixed action and launches Chromium. See PR/Branch State below
for the specific run IDs (cold-cache first run, then a warm-cache/cache-HIT run).

## What's Next

Nothing required. Optional follow-up: audit any other composite actions or
workflows that still combine `--with-deps` behind a browser-cache gate (this and
#715 are the two known instances; a repo grep for `--with-deps` behind a
`cache-hit` `if:` is a quick guard idea).

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-setup-node-pw-deps`
- All tests passing: yes (`verify:fast` green; full `verify` green)
- PR created: see PR link recorded at merge time

## Agent-OS Telemetry

Guard telemetry captured via: none (no `files/guard-telemetry.jsonl` produced this session)

## Test Results

`npm run verify:fast` → ✅ Fast verification passed.
`npm run verify` → recorded in session (typecheck, lint, format, guards, unit +
integration, PR prereqs, build). Headless Floor-1 gate deferred to its CI job
(no `src/core`/`src/game/ai`/balance changes).

## Key Decisions Made

- Mirror PR #715's exact two-step split rather than inventing a new pattern, for
  consistency across the two Playwright-install sites.
- Keep `shell: bash` on both new steps because composite-action `run:` steps require
  an explicit shell (the #715 workflow fix did not need this).
- Order the always-run `install-deps` step first for clarity; ordering is otherwise
  safe because `install-deps` needs only the `playwright` npm package (present after
  the node_modules cache/`npm ci`), not the browser binary.

## Retrospective

### Lessons Learned

`actions/cache` for Playwright caches only browser binaries under
`~/.cache/ms-playwright`; OS-level system libraries are **never** cached and must be
(re)installed on every run. Any step that both downloads the binary and installs
system deps must not be gated on the browser cache — split them.

### Mistakes Made

None material. One thing to watch: the reference (#715) is a top-level workflow so
its `run:` steps omit `shell:`; blindly copying it into a composite action would
drop the required `shell: bash` and fail. I preserved it.

### Opportunities for Future Improvement

A tiny lint/guard could flag `--with-deps` (or `install-deps`) sitting behind a
`cache-hit`-gated `if:`, preventing this bug class from recurring a third time.
