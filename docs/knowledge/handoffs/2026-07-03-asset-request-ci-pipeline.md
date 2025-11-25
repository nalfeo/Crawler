# Session Handoff: Asset-request CI pipeline

## Date

2026-07-03

## Persona(s) adopted

Infra plumber → CI/pipeline engineer. The task was capability-scoping ("can cloud
sessions reach Azure?") and then wiring an existing sidecar into a GitHub Actions
workflow. No game-logic, no ECS, no Phaser — pure infra + CLI + YAML.

## Routing verdict

✅ right persona — task was mechanical wiring of an existing feature into a new
trigger surface, not a design problem. Would have been overkill to route through
the Producer.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — plan review surfaced 10 concerns (4 blocking), code review
surfaced 4 more across 2 rounds (1 blocking, 1 high, 2 medium), all resolved.
No scope-creep beyond what the harness demanded.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

quests

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-asset-request-ci-pipeline.review-ledger.json`
Stages: plan_review ✅ (gpt-5.5) · code_review ✅ (gpt-5.5, 3 rounds — 2 with
concerns + 1 clean) · multi_model_review — N/A (3🍎 doesn't require it).

## What Was Done

Added a GitHub Actions pipeline that ingests `asset-request`-labeled issues into
the Azure sprite queue and drains the queue — all in CI, entirely on API-key
auth (no OIDC / no `az login` needed because the sprite worker uses
`AZURE_OPENAI_API_KEY` and `AZURE_STORAGE_KEY` directly).

**New files**

- `.github/workflows/asset-request.yml` — the pipeline itself. Triggers on
  `issues:{opened,edited,labeled,reopened}` + `workflow_dispatch`. Job-level
  `if:` gate requires trusted `author_association`. Step-level `env:` blocks
  scope Azure keys to only the two `run:` steps that need them (checkout +
  setup-node + `npm ci` do NOT see credentials).
- `scripts/sprites/ingest-once-cli.ts` — one-shot ingester CLI: `pollOnce()` and
  exit. Written specifically for CI (long-running sidecar wasn't necessary).
- `scripts/sprites/ingest-once-cli-lib.ts` — pure helpers so tests can import
  without triggering `main()` (which would instantiate real Azure/GH clients on
  import). Exports `resolveRequestedBy`, `exitCodeForStatus`,
  `resolveAllowedAuthorLogins`, `filterIssuesByAllowedAuthors`,
  `withAuthorAllowList`.
- `scripts/sprites/worker-cli-lib.ts` — extracted pure helpers from
  `worker-cli.ts`. Exports `isTruthyEnv`, `createDrainOnStatus`,
  `resolveDrainExitCode`.

**Changed files**

- `scripts/sprites/sidecar/issue-ingester-controller.ts` — exposed `pollOnce()`
  on the public interface. The CLI calls `await controller.pollOnce()` instead
  of watching the racy `lastPollAt` field (which was set at the TOP of the
  internal poll, before enqueue + state-save).
- `scripts/sprites/sidecar/asset-request-issue-api.ts` — added `author` to
  `gh issue list --json` fields; extended `OpenAssetRequestIssue` with an
  optional `readonly authorLogin?: string`.
- `scripts/sprites/worker-cli.ts` — added drain-mode support
  (`SPRITES_WORKER_DRAIN`, `SPRITES_WORKER_MAX_EMPTY_POLLS`), and a `errorCount`
  tracker that flips the exit code to 1 in drain mode when any 'error' status
  was observed. Long-running mode still exits 0 on message errors (unchanged).
- `package.json` — new `sprites:ingest-once` script.
- `AGENTS.md` — new row in the commands table.

**Tests added (14 new)**

- `tests/unit/sprites/asset-request-issue-api.test.ts` — updated primary test to
  assert new `--json number,body,author` args + `authorLogin` propagation;
  added test that `authorLogin` is `undefined` when `author` is missing/malformed.
- `tests/unit/sprites/issue-ingester-controller.test.ts` — added `pollOnce` awaits
  ingest completion + `pollOnce` surfaces errors via `lastError`.
- `tests/unit/sprites/worker-cli-lib.test.ts` — new file. `isTruthyEnv`,
  `createDrainOnStatus` (abort-after-N + reset-on-processing + once-only +
  passthrough), `resolveDrainExitCode` (drain off, drain+0 errs, drain+errs).
- `tests/unit/sprites/ingest-once-cli.test.ts` — new file. `resolveRequestedBy`
  branches, `exitCodeForStatus`, `resolveAllowedAuthorLogins` (unset, empty,
  whitespace, single, multi/case/dedupe), `filterIssuesByAllowedAuthors`
  (matches/case-insensitive, rejects undefined, empty), `withAuthorAllowList`
  (list wrapping + comment passthrough).
- `tests/unit/sprites/sidecar-server.test.ts` — added `pollOnce` to the
  `IssueIngesterController` mock so full `typecheck` (not just
  `typecheck:src`) passes.

## Runtime / real-artifact observation

N/A — no runtime/wiring change to the game. The workflow itself is the real
artifact; it can only be end-to-end validated once the branch is on `main` and
someone files a real asset-request issue (or dispatches manually). Local
verification: `npm run verify:fast` (3433/3433 pass; typecheck + lint + build
clean); `npm run typecheck` (previously failed with TS2741; now clean).

## What's Next

1. **Merge the PR** and file a test asset-request issue to end-to-end validate
   the pipeline. Watch the Actions tab for `Asset Request Pipeline`.
2. **Copilot cloud sessions are supported**: the workflow gate accepts issues
   filed by `user.login=Copilot` with `user.type=Bot` (the REST/webhook form),
   and the ingester allow-list includes `app/copilot-swe-agent` (the GraphQL
   form that `gh issue list --json author.login` returns). Both are needed
   because GitHub exposes the SAME bot under two different login strings
   depending on which API surfaces the data — the workflow gate reads the
   webhook payload, the ingester reads `gh` output.
3. **Consider re-adding `schedule:`** as a safety net if the fail-loud
   drain-mode + `issues:labeled` webhook path proves insufficient. The
   `SPRITES_INGESTER_ALLOWED_AUTHORS` filter protects the ingester side of any
   scheduled sweep — the only cost of adding schedule back is ~30s of CI per
   run for the empty-queue common case.
4. **Missing GH secret**: `AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT` is not
   currently stored on the repo. The workflow falls back to
   `AZURE_OPENAI_CHAT_DEPLOYMENT` — matches the local `setup-azure-env.ps1`
   default (`gpt-4o` for both). If you ever want a distinct deployment for the
   brief selector, `gh secret set AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT`.

## Blockers

None. All verify:fast + typecheck green.

## Branch State

- Branch: `ci/asset-request-workflow` (worktree `C:\tmp\Crawler-asset-ci`)
- All tests passing: yes (3433/3433 + typecheck + lint + build)
- PR created: no — awaiting user confirmation

## Agent-OS Telemetry

Guard telemetry captured via: none — no guard-telemetry.jsonl produced (no
Rules-of-Play violations tripped during infra work).

## Test Results

```
✅ Fast verification passed.
Test Files  290 passed (290)
     Tests  3433 passed (3433)
```

`npm run typecheck` — clean (no TS errors across the full tsconfig).

## Key Decisions Made

1. **Two CLIs, not one HTTP-server-in-CI**: `sprites:ingest-once` (one-shot
   poll) + `sprites:worker` in drain mode. Cleaner CI semantics than starting
   the sidecar HTTP server and POSTing to it. Also avoids leaking auth to a
   listening port.
2. **Fail-closed author filter**: The ingester rejects issues where
   `authorLogin` is `undefined`, not just non-allowed. This matters because
   `gh issue list --json` MAY omit `author.login` in edge cases (deleted
   accounts, mannequin actors, etc.). Fail-closed is the correct default
   under a whitelist.
3. **Secrets NOT in `copilot-setup-steps.yml`**: user's explicit call. Keeps
   the coding-agent's runner env free of Azure credentials so prompt-injected
   build steps can't exfiltrate them. Only this workflow (which runs on
   `permissions: contents: read` — no code checkout of untrusted PRs) carries
   the keys.
4. **`schedule:` trigger removed**: cron had no way to check
   `author_association`, so it would re-scan every open labeled issue
   regardless of who filed them. Removing it closed the last drive-by attack
   surface. `workflow_dispatch` is the manual override.
5. **Drain-mode fails loudly on errors**: instead of exiting 0 and hiding
   errored messages behind Azure Queue's 900s visibility timeout, the CI job
   goes red so the maintainer notices immediately.

## Retrospective

### Lessons Learned

- **`verify:fast` uses `typecheck:src`, not the full `typecheck`**. My initial
  `verify:fast` reported "✅ Fast verification passed" while a mock in a test
  file was silently missing a required interface method. Always run
  `npm run typecheck` in addition to `verify:fast` when adding methods to a
  public interface.
- **The sidecar's `pollOnce()` was setting `lastPollAt` BEFORE work**, not
  after. Discovered by the plan-review agent (gpt-5.5) reading the code, not
  by me. The plan-review harness paid for itself on this task.
- **Public repos + auto-labeling issue templates = free CI-spend attack surface**
  for any workflow that reacts to labels. The second-pass code review caught
  this after I'd already thought the security posture was tight. Two layers of
  defense (workflow `if:` gate + ingester `SPRITES_INGESTER_ALLOWED_AUTHORS`)
  are needed because the ingester scans ALL open issues per poll, not just the
  one that triggered the event.
- **`gh issue list --json` doesn't expose `authorAssociation`** (only
  `author.login`). So the ingester filter has to whitelist by login. That's
  slightly noisier config-wise but works.

### Mistakes Made

- **First round: env at job level instead of step level**. Standard GH Actions
  hygiene I know well — but I copied the shape from `ci.yml` without noticing
  it doesn't use secrets. Reviewer caught it.
- **First round: no author gate at all**. I assumed the label check was
  sufficient. It isn't for public repos with auto-labeling issue templates.
- **Second round: only ran `verify:fast`**. Full `typecheck` failed. Next time,
  run BOTH before declaring a code-review pass ready.

### Opportunities for Future Improvement

- **`verify:fast` should probably typecheck the tests too**, not just
  `--project tsconfig.src.json`. Would have caught the sidecar-server test
  mock issue before code review saw it. Follow-up worth considering (but
  out of scope here).
- **The ingester's `listOpenAssetRequestIssues` doesn't filter by author in
  the sidecar HTTP-server path** — the sidecar server is local-only so this
  isn't exploitable today, but a future "run sidecar in a shared/hosted
  environment" scenario would need to plumb `withAuthorAllowList` there too.
- **The Copilot cloud coding agent files issues/PRs as TWO different login
  strings depending on the API**: `Copilot` via REST/webhook payload,
  `app/copilot-swe-agent` via `gh` CLI (GraphQL). `author_association` is
  `CONTRIBUTOR` (not OWNER/MEMBER/COLLABORATOR), so a naive `author_association`
  gate rejects Copilot outright. Any workflow that wants to trust Copilot must
  either add an explicit login allow-list AND use `user.type == 'Bot'` for the
  webhook gate, OR carry BOTH login strings in any downstream allow-list that
  reads `gh` output.
