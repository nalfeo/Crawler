# PR Shepherd — Playbook & Command Cookbook

Operational detail for the `pr-shepherd` skill. All commands assume the
`nalfeo/Crawler` repo and a PowerShell shell on Windows. Read
[`../SKILL.md`](../SKILL.md) first for the merge facts and the high-level loop.

---

## Mode A — Coordinator

### 1. Discover open PRs

```powershell
gh pr list --repo nalfeo/Crawler --state open `
  --json number,title,headRefName,mergeStateStatus,isDraft,reviewDecision `
  --jq 'sort_by(.number)[] | "#\(.number) [\(.mergeStateStatus)] \(.headRefName) — \(.title)"'
```

### 2. Determine which PRs are in scope

A PR is **in scope** when no _active_ (non-archived) session is sitting on its
`headRefName`. Cross-reference:

- `list_sessions_and_chats` — list every session and its branch.
- `get_session <id>` — an **archived** session reports `archived: true` and an
  empty `path`. Archived owner ⇒ the PR is in scope (take it over).
- Confirm the branch is free in the real checkout before launching:
  `git -C C:\Users\nalfeo\.copilot\repos\Crawler worktree list`

Decision matrix (owner state → action):

| Owner session state         | Action                                                        |
| --------------------------- | ------------------------------------------------------------- |
| none                        | `open_pr_session` → launch a fresh shepherd                   |
| active (holds the worktree) | `send_session_message` to delegate; never touch its worktree  |
| archived / winding down     | take over directly; edit locked files via GitHub Contents API |

### 3. Launch one shepherd per in-scope PR (in parallel)

Use `open_pr_session` with a rich kickoff prompt. Recommended settings:

- `mode: autopilot` — shepherds drive to merge without check-ins.
- `notify_on_idle: once` — you get one idle notification when it finishes.
- `coordinate_with_creator: true` (default) — so it can message you results.

The kickoff prompt **must** include: the PR number + branch, the exact review
comments to address (paste them — the session can't see your context), the
specific failing CI check + run ID, the merge policy line
(`gh pr merge <n> --auto --squash`, no review required), and the instruction to
write a handoff + apple metric and report the final merge commit back.

> A single `open_pr_session` call sometimes returns a transient
> "Policy hook failed" / "Tool result blocked" message even though the session
> **was created server-side**. Verify with `list_sessions_and_chats` before
> retrying — a blind retry says "Session already exists".

**One PR = one child session, always.** Every blocker belongs to the shepherd,
not the coordinator: merge-conflict resolution, rebases onto `main`, and "quick"
CI fixes all go to the PR's own session. Do **not** check out a PR branch, open
a temp worktree, or edit locked files via the Contents API to hand-fix an
"easy" one — that breaks parallelism and pulls you out of the coordinator role.
The single exception is a child that has tried and genuinely cannot proceed
(documented as `shepherding-self`); only then take over directly.

### 4. Track progress in SQL

```sql
-- pr_shepherds: one row per PR you are shepherding this loop
CREATE TABLE IF NOT EXISTS pr_shepherds (
  pr_number        INTEGER PRIMARY KEY,
  branch           TEXT,
  title            TEXT,
  child_session_id TEXT,
  status           TEXT DEFAULT 'shepherding'  -- shepherding | shepherding-self | merged | blocked
);
```

Update `status='merged'` as each lands; use `shepherding-self` for PRs you own
at the `gh` level (active owner holds the worktree, but CI just needs watching).

### 5. Relay results

When an idle notification or cross-session merge report arrives: verify
independently with `gh pr view <n> --json state,mergedAt,mergeCommit`, update the
SQL row, reply to the child session to confirm, and give the user a consolidated
scorecard (merged vs still-in-flight, with merge commit SHAs).

> `read_agent` does **not** work on sessions created via
> `open_pr_session`/`create_session`. They report through cross-session messages
> and idle notifications, not the agent API.

---

## Mode B — Diagnose before giving up

`gh pr checks <n>` labels **`CANCELLED` runs as `fail`**. Most "failures" on this
repo are cancellations, not real defects. Always confirm:

```powershell
gh pr checks <n>                              # quick view (CANCELLED shows as fail)
gh run list --branch <branch> --limit 15      # find the real run + its status
gh run view <run-id> --log-failed             # read the actual error output
```

Real failure ⇒ fix the underlying cause, push a surgical commit, re-arm
auto-merge. Concurrency/timing artifact ⇒ no action; auto-merge proceeds once the
required checks report green on the latest head.

### Known non-failures (do not chase)

- **`Build` "skipping"** — expected; `Build` is not a required check.
- **`PR Ready/Reviewer Guard` CANCELLED** — historically a single global
  `concurrency.group` (no per-PR key) in
  `.github/workflows/pr-ready-reviewer-guard.yml` let concurrent rebases evict
  each other's pending run. Fixed in PR #325 (per-PR key
  `pr-ready-reviewer-guard-${{ github.event.pull_request.number || github.ref }}`),
  but the advisory check can still show transient cancels under heavy churn.
  It is non-required and never blocks merge.
- **`mergeStateStatus: BLOCKED` right after arming auto-merge** — usually the
  required `ci` workflow hasn't reported on the **latest** head yet (it triggers
  on `pull_request: [main]`; a fresh `synchronize` push kicks it), or a review
  thread is unresolved. Not a review block.

---

## Recipes

### Resolve a review thread (GraphQL on PowerShell)

Inline `-f query="... \"...\" ..."` fails on PowerShell with
`Expected VALUE, UNKNOWN_CHAR`. Write the query to a temp file instead:

```powershell
# fetch review threads
gh api graphql -F query="@$env:TEMP\threads.graphql" -F owner=nalfeo -F repo=Crawler -F pr=<n>
# resolve a thread
gh api graphql -F query="@$env:TEMP\resolve.graphql" -F threadId=<node-id>
```

`resolveReviewThread(input:{threadId:$threadId}){ thread { isResolved } }`.

### Edit a file on a branch you can't check out (Contents API, byte-faithful)

When the branch is locked in another worktree but you must take over:

1. `GET /repos/nalfeo/Crawler/contents/<path>?ref=<branch>` → base64 `content` + blob `sha`.
2. Decode → `UTF8.GetString`; normalize `\r\n` → `\n`.
3. Assert **exactly one** match of the target string before `.Replace` (fail otherwise).
4. Re-encode to base64; `PUT` the same endpoint with `message`, `content`, the
   blob `sha`, and `branch`. This preserves LF endings and produces a clean commit.

### Restore an auto-deleted head ref (stacked PRs)

Squash-merge deletes the branch. If a downstream stacked PR needs the head ref:

```powershell
# the pre-merge commit object survives; restore the ref to it
gh api -X POST repos/nalfeo/Crawler/git/refs `
  -f ref="refs/heads/<branch>" -f sha="<pre-merge-head-sha>"
```

A PR whose base is `main` does **not** need this — once it merges, downstream PRs
branch off `main` normally.

---

## Conventions every shepherd follows

- **Persona:** default **Producer** (`docs/agent-os/personas/producer.md`) for
  multi-layer/ambiguous shepherding work.
- **Apples:** declare a 🍎–🍎🍎🍎🍎🍎 estimate before writing code; score actuals
  at handoff in `docs/knowledge/metrics/apples/YYYY-MM-DD-<slug>.json`
  (`docs/agent-os/policies/complexity-policy.md`).
- **Handoff:** write `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` before ending.
  To avoid resetting a green, auto-merging PR, keep the shepherd handoff in your
  session artifacts rather than pushing a fresh commit onto the in-flight branch.
- **Validation:** `npm run verify:fast` after each change;
  `bash scripts/agent/lab-gate-check.sh` before opening/merging a PR.
- **Commits:** conventional type set; include the
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.
