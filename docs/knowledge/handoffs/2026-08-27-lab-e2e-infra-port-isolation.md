# Session Handoff: Isolate the e2e lab-server port and unblock docs:check

## Date

2026-08-27

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling, worktree-server

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — full summary in
`docs/knowledge/metrics/apples/2026-08-28-lab-e2e-infra-port-isolation.json`.

## What Was Done

Fixed issue #3781: intro-scene-flow e2e timeouts, `ui-probe-lab` inventory
failures under `npm run review:visual`, and a blocking `npm run docs:check`
path finding.

Both e2e suites turned out to pass on a clean checkout (intro 2/2 in ~20s;
inventory 26/26; hud-overlap 4/4), so the failures were harness shared state,
not test logic:

1. `tests/e2e/e2e-constants.ts` pinned the lab server to a machine-global port
   `5299` while the rest of the repo derives per-workspace ports from
   `scripts/shared/session-server-ports.js`. A second worktree — or a leftover
   server — owns the port first.
2. `tests/e2e/global-setup.ts` spawned Vite with `--strictPort` but only probed
   the port. On a collision our child died instantly while the probe connected
   to the **foreign** server and setup reported success, so the whole suite ran
   against another checkout's code. Child output was piped and discarded, so
   Vite's strictPort error was invisible. That is exactly "`page.goto` times
   out" plus "`window.__uiProbe.getInventoryMaxScrollRow` is missing".

Changes: a new `e2eLab` offset in the session port block (`e2eLabPort` /
`e2eLabBaseUrl`, `CRAWLER_E2E_LAB_PORT` override retained); readiness in
`global-setup.ts` now requires **our child's own** Vite ready banner (ANSI
stripped, port matched) before the port probe, raced against the child's
`exit`/`error`, with a bounded tail of its output in every failure message;
helpers extracted to `tests/e2e/lab-server-lib.ts` with unit coverage.

Three docs guards were also unblocked (all pre-existing on clean `main`, rule
7): an external-link-label false positive in `check-paths.ts` (`README.md:97`
links another repo's `docs/guides/github-token-scopes.md`), a
`path.ts::symbol` false positive in `check-adr-consistency.ts`, and a
`check-session-instructions.ts` expectation that had drifted from AGENTS.md's
current wording. One handoff was missing its required retrospective
subsection.

Observed in the real artifact: `npx vitest run --project e2e
tests/e2e/intro-scene-flow.test.ts` — before, an occupied port let setup
"succeed" and the tests failed 30s later on missing hooks; after, an occupied
port aborts the run in ~1s with `[e2e] Port 23363 is already in use…`, and with
a free port the suite boots and passes 2/2. `npm run review:visual:deterministic`
passes 30/30; `npm run docs:check` reports 0 blocking across all 12 stages.

## Key Decisions Made

1. Reuse `scripts/shared/session-server-ports.js` rather than invent a second
   port scheme — one canonical port authority for the whole repo.
2. Give the e2e server its **own** offset (3) instead of reusing `lab` (1), so a
   running `npm run lab` cannot steal the port the e2e suite is about to bind.
3. Prove server ownership with the child's ready banner, not a port probe. A
   reachable port only proves _something_ listens; the banner is emitted by the
   process we spawned, which closes the check-then-spawn race.
4. Fix the docs guards generically (link labels, `path::symbol`) rather than
   allowlisting individual paths — both false positives will otherwise recur.
5. Did **not** raise e2e timeouts. That would mask the collision and would not
   stop a run against another worktree's stale code.

## What's Next / Blockers

- **Validation gap:** the reporter's failures were on Windows; this sandbox is
  Linux. Someone should rerun `npm run test:e2e -- tests/e2e/intro-scene-flow.test.ts`
  and `npm run review:visual` on Windows to confirm, and read the newly surfaced
  child output if anything still fails.
- `scripts/agent/review/visual-review-agent.ts` still defaults `--url` to the
  hardcoded `http://127.0.0.1:4176/lab.html?lab=ui-probe-lab` (also in
  `package.json`, `.github/skills/visual-review/SKILL.md`, and
  `docs/guides/visual-review-process.md`). Same class of bug, left out of scope
  because the LLM stage was not the reported failure; worth a follow-up that
  migrates it onto `labBaseUrl`.

## Retrospective

### Lessons Learned

- "Reproducible on clean main" from one machine plus "passes on clean main" from
  another is a strong tell for **shared machine state**, not a code bug. Running
  the suites first, before reading any test code, is what turned a vague
  timeout report into a specific port-ownership bug.
- Playwright browsers are not installed in a fresh cloud sandbox; `npx playwright
install chromium` is a prerequisite for any e2e work here.
- Vite's ready banner is ANSI-coloured and inserts escape codes _inside_ the port
  number (`http://localhost:\e[1m23399\e[22m/`), so any matcher must strip
  colours first — a naive `:<port>` substring check silently never fires.

### Mistakes Made

- Started the deterministic visual-review run while a test squatter still held
  the derived port from the previous experiment, and briefly read the resulting
  failure as a regression. Early signal: the error names the port and says
  "already in use" — check for leftover processes before re-diagnosing.
- Wrote the setup regression test with a query-string dynamic import
  (`import(\`../e2e/global-setup.js?port=${p}\`)`) to dodge module caching; Vite
rejects variable dynamic imports. `vi.resetModules()` plus a literal path is
  the working pattern for re-importing a module that reads env at load time.

### Opportunities for Future Improvement

- Audit the repo for any remaining machine-global hardcoded ports and migrate
  them onto `session-server-ports.js`; the 2026-06-16 handoff called this out and
  the e2e suite was still missed 2+ months later. A cheap deterministic guard
  (grep for `localhost:<4-5 digits>` outside the port helper) would stop the next
  one.
- `check-session-instructions.ts` stores a verbatim copy of an AGENTS.md bullet,
  so every rewording of that bullet hard-fails `docs:check` for everyone until
  the guard is re-synced. Matching on the stable bold bullet heading, with the
  prose free to evolve, would keep the "this policy exists" guarantee without the
  drift.
