# copilot-guards

Deterministic pre-tool-use guards that enforce Crawler project conventions at
the tool-call boundary. Stops the agent from doing the wrong thing instead of
hoping it remembers to do the right thing.

Loaded automatically because it lives under `.github/extensions/`.

---

## What's enforced

| Guard ID                     | Tool(s)                                 | Decision | What it blocks                                                                                                                                                                                                         |
| ---------------------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell-force-push-main`      | `powershell`, `bash`                    | **deny** | `git push --force` (or `-f`, `--force-with-lease`, `+main:main` refspec) targeting `main`/`master`.                                                                                                                    |
| `shell-main-branch-delete`   | `powershell`, `bash`                    | **deny** | `git push origin --delete main`, `git push origin :main`, `git branch -D main` (and `master`).                                                                                                                         |
| `shell-gh-pr-create`         | `powershell`, `bash`                    | **deny** | `gh pr create` from the shell. Tells the agent to use the `create_pull_request` tool so PR guards run.                                                                                                                 |
| `shell-rm-rf-repo`           | `powershell`, `bash`                    | **deny** | `rm -rf .` / `./` / `*` / `./*` / `/` / `~` / `..` / absolute paths, plus the PowerShell equivalent `Remove-Item . -Recurse -Force`. Recognizes both `-r`/`-R` and `--recursive`.                                      |
| `shell-unsafe-port-kill`     | `powershell`                            | **deny** | `Get-NetTCPConnection` / `Win32_Process` + `Stop-Process` server-kill commands on legacy shared ports unless they are scoped to the current worktree path.                                                             |
| `authoring-main-sync`        | all except `create_pull_request`        | allow    | Measures active authoring intervals and safely rebases after 30 active minutes when clean; otherwise adds a non-blocking checkpoint/sync reminder.                                                                     |
| `edit-determinism`           | `edit`, `create` (src/core,game,shared) | **deny** | New `Math.random()`, `Date.now()`, `performance.now()` calls. Tests and `src/labs/**` exempt. Comments/strings ignored.                                                                                                |
| `edit-phaser-in-core`        | `edit`, `create` (src/core)             | **deny** | `import 'phaser'`, `require('phaser')`, `import('phaser')` inside `src/core/**`.                                                                                                                                       |
| `edit-repo-md-junk`          | `create` (`*.md`)                       | **deny** | New `.md` files outside the allowlist (see below). Use the session artifacts folder for planning notes.                                                                                                                |
| `edit-guard-self-protection` | `edit`, `create` (this extension)       | **ask**  | Modifications to `.github/extensions/copilot-guards/**` unless `COPILOT_GUARDS_EDIT=1`.                                                                                                                                |
| `pr-preflight`               | `create_pull_request`                   | **deny** | Aggregated PR checks plus a non-blocking pre-publish main-sync attempt.                                                                                                                                                |
| `pr-review-ledger`           | `create_pull_request`                   | **deny** | Code-touching PR without a valid, complete **review ledger** for its declared apple tier. Docs/art/deps-only diffs are skipped. See [review-harness-policy](../../../docs/agent-os/policies/review-harness-policy.md). |

### `pr-preflight` checks in detail

| Check            | What                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Handoff required | A `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` file must be added in the branch diff. Skipped for docs-only diffs.      |
| Lab gate         | Runs `scripts/agent/lab-gate-check.sh` **only** when the diff touches `src/core/systems/**` or `src/labs/**`. Cached.     |
| Forbidden paths  | Hard-deny on `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.copilot/`, `session-state/`, `generated/`, `*.log`, `node_modules/`. |
| Cross-system ADR | Hard deny when the diff spans 2+ of `src/core`, `src/engine`, `src/game` without an ADR in the branch.                    |
| Main sync        | Safely rebases a clean branch before publication; failures and dirty worktrees warn but never deny by themselves.         |

For earlier feedback in the local completion loop (without waiting for
`create_pull_request`), run `npm run verify:pr-prereqs` (included in
`npm run verify`).

### `pr-review-ledger` in detail

Enforces the apple-scaled review harness (see
[`review-harness-policy.md`](../../../docs/agent-os/policies/review-harness-policy.md)).
It is a **standalone** `pr` guard (it does not modify `pr-preflight`) and is
`failClosed: true` — an unexpected crash denies; the one intentional
allow-through is a git failure (surfaced as context for manual review).

| Step             | What                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope            | `lib/pr-scope.mjs` strict allowlist. Skips a diff only if **every** file is docs (`docs/**`, root `*.md`/`*.txt`), art (`public/assets/**`, `briefs/**`, `data/palettes/**`), or a dependency lockfile. `src/**` is never skippable. |
| Ledger discovery | Looks for `docs/knowledge/review-ledgers/<date>-<slug>.review-ledger.json` **added on this branch** (an old ledger on `main` does not count).                                                                                        |
| Validation       | Validates every added ledger via `scripts/agent/review/ledger.mjs` (the same module the `npm run review:ledger` CLI uses). Missing or incomplete for the declared apple tier → hard deny with the exact failing rule.                |

### `edit-repo-md-junk` allowlist

- Root: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`
- `docs/**`
- `.github/**` (any markdown)
- `.specify/**`
- `src/labs/**/{README,SPEC}.md`
- `public/assets/**/README.md`

Everything else is denied. Use the session artifacts folder (`~/.copilot/session-state/<id>/files/`) for planning notes.

---

## Bypass mechanisms

These exist for legitimate edge cases (hotfixes, intentional maintenance). Every bypass is logged via `session.log({level:'warning'})` so it's visible.

| Mechanism                                    | Effect                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| `COPILOT_GUARDS_DISABLE=guard-id,other-id`   | Disables specific guards for the session.            |
| `COPILOT_GUARDS_DISABLE=*`                   | Disables all guards (escape hatch).                  |
| `COPILOT_GUARDS_EDIT=1`                      | Allows edits to this extension without `ask` prompt. |
| `config.json` → `"disabled": true` per guard | Repo-wide opt-out (committed).                       |

**Recommendation:** never set `COPILOT_GUARDS_DISABLE=*` in CI. Set it in a single shell when you intentionally need to bypass.

---

## NOT enforced (and why)

- **TypeScript / ESLint correctness.** Already covered by `npm run typecheck` and `npm run lint`. Pre-tool hooks would be redundant and slow.
- **Test coverage.** Too subjective at the pre-tool level. CI enforces coverage thresholds.
- **"Read your persona."** Can't be deterministically verified.
- **Conventional commit / semantic PR title format.** Conventional commit enforcement was removed (PR #1109). Commit and PR title format is no longer enforced by CI or preflight.
- **`gh pr merge --delete-branch`.** This deletes the PR head branch (cleanup), not `main`. Blocking it would block normal post-merge cleanup. We do block deletion of `main`/`master` itself.
- **Co-authored-by trailer on commits.** Considered but deferred (modify-vs-warn ambiguity). Add a new `shell-commit-trailer` guard if you want this.
- **Review-ledger _truthfulness_.** The `pr-review-ledger` guard validates that a review ledger is **complete** for its apple tier, not that the reviews honestly happened or that the reported counts are accurate. Like the handoff requirement, it is an honor-system artifact — the forcing function and audit trail are the value. Project rule #12 forbids weakening a stage to go green.

---

## How a guard works

Each guard module exports:

```js
export default {
    id: "shell-force-push-main",           // stable id used in config & bypass env
    category: "shell" | "edit" | "pr",     // dispatcher behavior; pr-category guards aggregate
    failClosed: true,                      // on exception, deny (safety) vs allow (advisory)
    matches(toolName, toolArgs) { ... },   // cheap predicate: should I look at this?
    async check(toolArgs, ctx) {           // returns { decision, reason?, additionalContext? }
        return { decision: "deny", reason: "..." };
    },
};
```

`ctx` provides `cwd` and `log(msg, opts)`. Decisions are `"allow"`, `"deny"`, `"ask"`, or `"skip"`.

### Telemetry artifact

Every guard decision is also appended to `files/guard-telemetry.jsonl` in the
current worktree. Near session end, run `npm run telemetry:capture -- <session-slug>`
to write a committed, contamination-filtered per-session summary under
`docs/knowledge/metrics/guard-telemetry/` — this is the durable path the
cross-session analyzer reads. `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section`
still generates a paste-able handoff block as a fallback.

Fixture guard ids used by this extension's own tests (e.g. `boom`, `shell-bad`,
`pr-hard`) are quarantined by the analyzer, so guard-dev sessions never skew the
real fire-rate. Dispatcher tests write telemetry only to a temp dir, never the
repo-root artifact.

### Guards are loaded once per session — reload after syncing main

**The extension host loads guards once, when the session starts.** A guard that
lands on `main` after your session began is **not** running in your session, even
after you `git pull`. It is not merely missing from telemetry — it is not
protecting you.

**Run `extensions_reload` immediately after every `git pull`/rebase onto main.**

This was found empirically: a long-running session started 2026-07-25T06:08 and
`authoring-main-sync` merged at 19:12 the same day. Over the next two days that
session recorded **10 guard events, all PR-time**. A single `extensions_reload`
took it to 12 within seconds, with `authoring-main-sync` firing on the very next
`grep` and `powershell` call.

The fingerprint of this bug in the committed corpus: **68 of 71** per-session
telemetry files contain only `pr-preflight`/`pr-review-ledger` events (2–14
events), while the 3 files with real per-tool coverage (176/238/371 events) all
contain `authoring-main-sync`. The two guard sets never co-occur — which is what
"the session predates the guard" looks like at scale, not a sampling artifact.
So near-empty telemetry is a **signal to reload**, not evidence of a quiet
session.

### Dispatcher semantics

- Shell/edit guards: first `deny` wins (fail fast on danger).
- PR guards (`category: "pr"`): collected into a single combined report so the agent sees every issue in one round trip.
- `additionalContext` from any guard is concatenated and returned even when the overall decision is `allow`.
- A guard that throws is logged and treated per its `failClosed` flag (safety guards fail-closed; advisory guards fail-open).

### Session-store attribution format

Every denial or ask reason string is formatted as:

```
[copilot-guards/<id> | tool:<toolName>] <reason>
```

For PR aggregate `create_pull_request` decisions, each guard line carries its own
parseable marker:

```text
PR preflight failed. Fix the following before retrying create_pull_request:
  ❌ [copilot-guards/pr-preflight | tool:create_pull_request] <reason>
  ❌ [copilot-guards/pr-review-ledger | tool:create_pull_request] <reason>
```

This embeds both the guard id and the denied tool name so that Chronicle
session-store SQL queries can attribute denials **even when the `tool_start_name`
column is NULL** (tool was pre-empted, never started):

```sql
-- All guard denials in last 7 days
WHERE tool_complete_result_content ILIKE '%[copilot-guards/%'
  AND tool_complete_result_content ILIKE '%"permissionDecision":"deny"%'
  AND timestamp > now() - INTERVAL '7 days'

-- Extract every guard id + tool marker from result content
SELECT
  unnest(
    regexp_extract_all(
      tool_complete_result_content,
      '\[copilot-guards/([^|]+) \| tool:([^\]]+)\]',
      1
    )
  ) AS guard_id,
  unnest(
    regexp_extract_all(
      tool_complete_result_content,
      '\[copilot-guards/([^|]+) \| tool:([^\]]+)\]',
      2
    )
  ) AS denied_tool
FROM events
WHERE tool_complete_result_content ILIKE '%[copilot-guards/%'
  AND tool_complete_result_content ILIKE '%"permissionDecision":"deny"%'
  AND timestamp > now() - INTERVAL '7 days'
```

The `files/guard-telemetry.jsonl` artifact remains the authoritative per-decision
record; the session-store format above is a supplementary query path for
Chronicle's cross-session fire-rate reports.

---

## Adding a new guard

1. Create `guards/<id>.mjs` exporting the shape above. Use `lib/` helpers.
2. Add an entry in `config.json`.
3. Import and register it in `extension.mjs`.
4. Write a `tests/<id>.test.mjs` using `node --test` and `node:assert/strict`.
5. Run `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"`.
6. `extensions_reload` activates it without a restart.

---

## Running the tests

```sh
npm run test:guards
```

This is the CI-wired runner (the `check-format-and-labs` job and
`scripts/agent/verify.sh` both call it). It runs the guard suite **and** the
review-ledger validator + CLI suite:

```sh
node --test ".github/extensions/copilot-guards/tests/*.test.mjs" "scripts/agent/review/*.test.mjs"
```

Pure-function guards, no harness needed. 182 tests across both suites cover normalization, individual guards (including `pr-review-ledger` scope classification, ledger decisioning, and the git-error allow-through), dispatcher behavior, and the review-ledger validator + CLI input hardening.

---

## Files

```
.github/extensions/copilot-guards/
├── extension.mjs              # joinSession + onPreToolUse dispatch
├── config.json                # per-guard enable + severity
├── README.md                  # this file
├── lib/
│   ├── config.mjs             # config loader + COPILOT_GUARDS_DISABLE handling
│   ├── dispatcher.mjs         # guard dispatch loop, pr aggregation, fail-closed/open
│   ├── git.mjs                # cached merge-base / branch-files / branch-subjects
│   ├── pr-scope.mjs           # strict-allowlist code-vs-(docs/art/deps) classifier (pr-review-ledger)
│   ├── shell.mjs              # command normalization, tokenization, program detection
│   └── strip-comments.mjs     # comment-only and comment+string strippers
├── guards/
│   ├── shell-force-push-main.mjs
│   ├── shell-main-branch-delete.mjs
│   ├── shell-gh-pr-create.mjs
│   ├── shell-rm-rf-repo.mjs
│   ├── shell-unsafe-port-kill.mjs
│   ├── edit-determinism.mjs
│   ├── edit-phaser-in-core.mjs
│   ├── edit-repo-md-junk.mjs
│   ├── edit-guard-self-protection.mjs
│   ├── pr-preflight.mjs
│   └── pr-review-ledger.mjs   # validates the review ledger (imports scripts/agent/review/ledger.mjs)
└── tests/
    └── *.test.mjs             # 150 tests, node --test
```
