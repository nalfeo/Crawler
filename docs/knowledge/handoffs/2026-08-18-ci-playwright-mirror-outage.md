# CI: Ubuntu mirror outage failing all of main CI and blocking deploys

## Systems touched

ci

## Summary

Every main CI run since 18:15 UTC on 2026-08-18 failed; everything before was
green. All three failures (`32175868131`, `32170055031`, `32170021692`) were in
the same place: `.github/actions/setup-node`'s `Install Playwright system
dependencies` step, exit code 124.

`playwright install-deps chromium` is an apt operation. `azure.archive.ubuntu.com`
became unreachable, apt retried it until the 10-minute timeout, and the step
failed. Every other mirror succeeded.

The blast radius was much larger than a red check. The deploy workflow's release
gate requires `workflow_run.conclusion == success`, and that conclusion is
captured at trigger time, so a transient upstream mirror outage **silently
blocked every deploy**. The dev bundle stayed stale even though the merged code
was fine, which is what blocked the telemetry keepalive fix (#3095) from
reaching the dev site. Re-running Deploy cannot fix this — only a new successful
CI run can.

### Root cause

The apt install was treated as a hard gate, but it was only ever a _proxy_ for
the requirement we actually have: Chromium can launch. The runner image already
ships Chromium's system libraries, and the logs confirm the browser cache hit
(`Cache restored from key: playwright-Linux-562b4bbb...`) — Chromium was
launchable the whole time. CI failed on a stale proxy, not a real defect.

The pre-existing retry block was cosmetic: it printed a friendly message and
then still ran `exit "$status"`.

### Fix

- The apt step is now best-effort: it emits a `::warning::` and continues, with
  the timeout cut from 10m to 5m so a mirror outage costs 5 minutes rather than
  failing the run.
- A new authoritative gate, `scripts/agent/verify-chromium-launch.mjs`, launches
  Chromium, opens a page, and confirms JavaScript evaluates. It depends only on
  the local browser install, never on package mirrors. When a system library
  genuinely is missing, Playwright's launch error names it — a far better
  diagnostic than an apt timeout.

This does not weaken the gate (rule #11); it moves it onto the real requirement.
A genuinely broken Chromium still fails CI, and now fails in seconds with an
actionable message instead of after a 10-minute hang.

## Files touched

- `.github/actions/setup-node/action.yml` — apt step made best-effort (warn, no
  `exit "$status"`, 10m → 5m); new `Verify Chromium launches` step.
- `scripts/agent/verify-chromium-launch.mjs` — new; exports `verifyChromiumLaunch`
  and runs as a CLI. Closes the browser in a `finally` so a failure never leaks a
  process.
- `tests/unit/setup-node-playwright-readiness.test.ts` — new; 5 regression tests.

## Verification run

- `npx vitest run tests/unit/setup-node-playwright-readiness.test.ts --project unit`
  → 5 passed.
- **Fail-to-pass verified**: with `action.yml` stashed, the 2 contract tests fail
  (2 failed | 3 passed); restored, all 5 pass.
- `npm run typecheck` → clean.
- `bash scripts/agent/verify-fast.sh` → passed.
- Authoritative check is this PR's own CI: `Lightweight Checks` exercises the
  changed composite action directly, so a green run on this branch is the real
  before/after evidence.

## Unresolved issues

- **The deployed Azure Function is ahead of `main`'s source.** Live preflight
  echoes `Access-Control-Allow-Headers: content-type,x-run-upload-mode`, but
  `functions/dev-build-ingest/src/index.ts` in `main` hardcodes only
  `content-type`; live also uses `CRAWLER_FEEDBACK_PAT` while the source reads
  `CRAWLER_CI_PAT`. A redeploy from `main` would regress both. The
  `labels: ['telemetry']` change also only takes effect once the function is
  redeployed.
- **`tests/unit/dev-build-ingest-handler.test.ts` is broken in this
  environment** — all 5 tests fail with `getaddrinfo ENOTFOUND
unittest.blob.core.windows.net` and hang 16–30s each; the `@azure/storage-blob`
  mock does not intercept every path. Pre-existing, but a rule #7 obligation.
- Vitest cannot import a `.mjs` with a shebang (`vite:import-analysis` fails to
  parse it) and decodes non-ASCII bytes such that an em-dash in a comment throws
  `SyntaxError: Invalid or unexpected token`. Both cost time here; any
  `scripts/agent/*.mjs` intended to be unit-tested must be ASCII and
  shebang-free.

## Recommended next steps

1. Land this PR and confirm main CI goes green.
2. Confirm the Deploy workflow then runs and dev `version.json` advances to a
   commit containing `3628955` (the keepalive fix).
3. Notify session `d98017eb-bef7-441b-88fd-956df27585ba` so it can run the agreed
   narrowed E2E: completed run → survey upload HTTP success → GitHub issue
   labeled `telemetry`. The quit path is explicitly out of scope.
4. Separately reconcile the deployed Function with `main`'s source before any
   redeploy.
