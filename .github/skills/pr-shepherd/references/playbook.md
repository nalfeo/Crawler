# PR Shepherd — Playbook & Command Cookbook

Operational detail for the `pr-shepherd` skill. All commands assume the
`nalfeo/Crawler` repo and a PowerShell shell on Windows. Read
[`../SKILL.md`](../SKILL.md) first for the merge facts and the high-level loop.

---

## Mode A — Coordinator

### Refresh loop shorthand

When the user says **'refresh'**, run the full coordinator pass in one sweep:

1. Repoll open PRs.
2. Re-evaluate in-scope ownership (none, archived, or idle >30m).
3. Launch one shepherd child session per in-scope PR immediately.
4. Update pr_shepherds rows for all launched PRs.

### 1. Discover open PRs

```powershell
gh pr list --repo nalfeo/Crawler --state open `
  --json number,title,headRefName,mergeStateStatus,isDraft,reviewDecision `
  --jq 'sort_by(.number)[] | "#\(.number) [\(.mergeStateStatus)] \(.headRefName) — \(.title)"'
```

### 2. Determine which PRs are in scope

A PR is **in scope** when either no _active_ (non-archived) session is sitting
on its `headRefName`, or the owning session has been idle for more than
30 minutes. It must also have no unexpired `ci-owner-pr-N` shepherd lease and no
active CI-recovery task in the `<!-- crawler-ci-state:v1 -->` sticky comment.
Cross-reference:

- `list_sessions_and_chats` — list every session and its branch.
- `get_session <id>` — an **archived** session reports `archived: true` and an
  empty `path`. Archived owner ⇒ the PR is in scope (take it over).
- `get_session <id>` — use `updated_at` to compute idle time.
  `now - updated_at > 30 minutes` ⇒ the PR is in scope (take it over).
- Confirm the branch is free in the real checkout before launching:
  `git -C C:\Users\nalfeo\.copilot\repos\Crawler worktree list`

Decision matrix (owner state → action):

| Owner session state     | Action                                                       |
| ----------------------- | ------------------------------------------------------------ |
| none                    | `open_pr_session` → launch a fresh shepherd                  |
| active (updated <=30m)  | `send_session_message` to delegate; never touch its worktree |
| active (idle >30m)      | `open_pr_session` takeover shepherd for that PR              |
| archived / winding down | `open_pr_session` takeover shepherd for that PR              |

### 2a. Acquire the GitHub-native shepherd lease

Generate a non-secret ownership identifier, dispatch the trusted workflow, wait
for that run to finish, and verify the sticky comment before launching or
editing:

```powershell
$leaseId = "shepherd-$([guid]::NewGuid())"
gh workflow run ci-recovery.yml --repo nalfeo/Crawler --ref main `
  -f operation=lease-acquire -f pr_number=<n> `
  -f trigger=pr-shepherd -f lease_id=$leaseId
gh run list --repo nalfeo/Crawler --workflow "CI Recovery" --event workflow_dispatch --limit 10
gh pr view <n> --repo nalfeo/Crawler --comments
```

Pass `$leaseId` in the child kickoff prompt. The child heartbeats after every
meaningful action and at least every 20 minutes:

```powershell
gh workflow run ci-recovery.yml --repo nalfeo/Crawler --ref main `
  -f operation=lease-heartbeat -f pr_number=<n> `
  -f trigger=pr-shepherd -f lease_id=$leaseId
```

After all blockers are clear, release the lease, then hand the PR to the train
(never arm auto-merge — see [`../SKILL.md`](../SKILL.md)):

```powershell
gh workflow run ci-recovery.yml --repo nalfeo/Crawler --ref main `
  -f operation=lease-release -f pr_number=<n> `
  -f trigger=pr-shepherd -f lease_id=$leaseId
```

Workflow-dispatch inputs are visible, so the lease ID is intentionally not a
secret. Repository write permission is the trust boundary. A lease is
takeover-eligible after 30 minutes without a heartbeat; the workflow adds five
minutes of queue-jitter grace before automated takeover.

### 3. Launch one shepherd per in-scope PR (in parallel)

Use `open_pr_session` with a rich kickoff prompt. Recommended settings:

- `mode: autopilot` — shepherds drive to merge without check-ins.
- `notify_on_idle: once` — you get one idle notification when it finishes.
- `coordinate_with_creator: true` (default) — so it can message you results.

The kickoff prompt **must** include: the PR number + branch, the exact review
comments to address (paste them — the session can't see your context), the
specific failing CI check + run ID, the merge policy line (the `merge-train`
label is the only merge path — **never** `gh pr merge --auto`, no review
required), and the instruction to heartbeat/release the supplied lease, write
a handoff + apple metric, and report the final merge commit back.

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

Real failure ⇒ fix the underlying cause, push a surgical commit, let the train
pick the PR back up on its next reconcile. Concurrency/timing artifact ⇒ no
action; the train admits the PR once required checks report green on the
latest head.

### Known non-failures (do not chase)

- **`Build` "skipping"** — expected; `Build` is not a required check.
- **`PR Ready/Reviewer Guard` CANCELLED** — historically a single global
  `concurrency.group` (no per-PR key) in
  `.github/workflows/pr-ready-reviewer-guard.yml` let concurrent rebases evict
  each other's pending run. Fixed in PR #325 (per-PR key
  `pr-ready-reviewer-guard-${{ github.event.pull_request.number || github.ref }}`),
  but the advisory check can still show transient cancels under heavy churn.
  It is non-required and never blocks merge.
- **`mergeStateStatus: BLOCKED` right after the `merge-train` label is applied** —
  usually the required `ci` workflow hasn't reported on the **latest** head yet
  (it triggers on `pull_request: [main]`; a fresh `synchronize` push kicks it),
  or a review thread is unresolved. **CRITICAL: Check for unresolved conversation
  threads FIRST — Copilot review threads are the #1 train-admission blocker.**
  Unresolved threads (especially from `copilot-pull-request-reviewer`) will
  silently block train admission even when all CI checks pass. Resolve the
  thread → the train picks the PR up on its next reconcile → merge completes.
- **`mergeStateStatus: BLOCKED` even after `ci` is green** — the Merge Train is the
  promotion path; the ruleset requires `merge-train` for ordinary actors but the trusted
  App has `bypass_mode: always`. **`merge-train` is written by reconciliation on the PR
  head immediately before the App-bypass squash-merge** — it is not a check that appears
  early enough for `gh pr checks` to show before promotion. What batch validation
  publishes is `merge-train-candidate` on the current `main` SHA (not on the PR head).
  **Remedy:** ensure the PR has the `merge-train` admission label (CI recovery adds it
  once CI, review threads, and code-review admission checks all pass) and CI stays green;
  the train will pick it up on its next cycle and promote via App bypass. Do **not**
  arm `gh pr merge --auto` as a substitute or safety net — it cannot satisfy the
  required `merge-train` context and only produces false confidence. Do not treat a
  missing `merge-train` check in `gh pr checks <n>` as an actionable blocker to diagnose.
- **Any manually-armed auto-merge is disarmed by the Merge Train** — the Merge Train's
  `reconcile` job (`merge-train.yml`) **actively disarms any manually-armed
  `gh pr merge --auto`** each time it processes a PR in its queue (log line:
  `disabled armed auto-merge pr=#NNNN`). This is normal, not a failure — do not
  re-arm it; the actual promotion is always performed by the train's App. Do not
  interpret a disarmed auto-merge as a blocker unless CI itself is failing.
- **Security-audit asymmetry (train-wide block risk)** — `ci.yml` runs `npm audit`
  with `continue-on-error: true`, so a pre-existing advisory finding shows as
  advisory-only and never blocks an individual PR's CI. `merge-train-validate.yml`'s
  "Candidate security verification" step runs `npm run security:check` **without**
  `continue-on-error`, making it a hard gate on the entire train. A single repo-wide
  `npm audit` finding can pass every individual PR's CI while silently blocking the
  **entire Merge Train** for every queued PR. If `merge-train-validate.yml` fails with
  an audit finding, queue a security-fix PR in the train: candidate validation is
  cumulative, so once the queued candidate includes the fix, the security step can
  pass and the train advances in order. The fix PR does **not** need to land via
  ordinary merge first (and ordinary merge is blocked by the ruleset anyway).

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

### Train-admission verification: verify merge completes, don't assume

**CRITICAL:** Do not go idle immediately after applying the `merge-train` label.
Shepherds must **verify the merge actually completes** with `state === "MERGED"`
and `mergeCommit !== null`. If the PR appears stuck in the queue, use this
diagnosis recipe:

```powershell
# 1. Check for unresolved conversation threads FIRST (Copilot review threads are #1 blocker)
gh pr view <n> --json reviews | jq '.reviews[] | select(.state == "COMMENTED")'

# If any Copilot review is COMMENTED and has unresolved threads:
#   - Get thread node IDs: gh api graphql -f query='query { repository(...) { pullRequest(...) { reviewThreads(first:50) { nodes { id, isResolved } } } } }'
#   - Resolve each: gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"PRRT_..."}) { thread { isResolved } } }'
#   - Confirm the PR still carries the `merge-train` label; the train re-admits it
#     on its next reconcile once threads are resolved
#   - Wait and verify merge completes

# 2. Verify merge completed
gh pr view <n> --json state,mergeCommit,mergeStateStatus
# Expected: state="MERGED" + mergeCommit.oid=<sha> (not null)
```

**Why:** Train admission can stall silently when unresolved review threads
exist. The train will not merge a queued PR until threads are resolved **even
if** all CI checks pass. This is the #1 reason shepherds have mistakenly gone
idle, thinking "the train will handle it" — they didn't check for blocking
threads first.

**Shepherd responsibility:**

1. Ensure the PR carries the `merge-train` label (never `gh pr merge --auto --squash`)
2. Poll up to the train's reconcile cadence: check `gh pr view <n> --json state,mergeStateStatus,mergeCommit`
3. If `mergeStateStatus` is still `BLOCKED`, check for unresolved review threads (GraphQL query above)
4. If threads found: resolve them; the train re-admits the PR on its next reconcile
5. Verify merge completes: `state === "MERGED"` + `mergeCommit !== null`
6. Only then go idle (report merge commit SHA to creator)

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
- **Apples:** declare a 🍎–🍎🍎🍎🍎🍎 estimate before writing code; for **≥3🍎 sessions** run
  `npm run apples:record -- --session <slug> --estimated <n> --actual <n>` at handoff
  (`docs/agent-os/policies/complexity-policy.md`). 1–2🍎 sessions need no file.
- **Handoff:** write `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` before ending.
  To avoid resetting a green, auto-merging PR, keep the shepherd handoff in your
  session artifacts rather than pushing a fresh commit onto the in-flight branch.
- **Validation:** `npm run verify:fast` after each change;
  `bash scripts/agent/lab-gate-check.sh` before opening/merging a PR.
- **Commits:** conventional type set; include the
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.
