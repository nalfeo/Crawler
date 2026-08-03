# ADR: Sprite queue reconciler — hourly `assets/queue → main` acceptance via a sole-writer promote branch

## Status

Accepted

## Date

2026-07-24

## Estimated Complexity

🍎 x 3 — CI automation + asset-pipeline tooling scripts + this ADR. No
`src/core`, `src/engine`, or `src/game` runtime change and no shipped game-data change, so the
tooling-only apple cap (≤3🍎) applies even with the extra `assets/promote`
branch. This is **PR2** of the durable asset-queue feature
([`2026-07-23-durable-asset-queue-persistence.md`](2026-07-23-durable-asset-queue-persistence.md)).

## Context

PR1 made approved/edited sprite art **durable** by pushing the changed art
surface to a long-lived remote **`assets/queue`** branch the moment a mutation
succeeds (queue-commit primitive + approve/editor/revert callers). But nothing
lands `assets/queue` back into `main`, so queued edits never reach the shipped
game. PR2 is the automated reconciler that closes that gap on a cadence.

The literal PR2 spec was **"arm `gh pr merge --auto --squash` on an
`assets/queue → main` PR."** A separate-model plan review (gpt-5.4, high effort)
returned `major_fork` / RECONSIDER and identified a **trust-boundary TOCTOU**
that made that design unsafe:

- **CTX-001 — head-drift TOCTOU (blocking).** `assets/queue` takes **every**
  editor/approve save, so its head advances continuously. Arming `--auto` on
  that mutable head validates the diff **at arm time only**; any push landing in
  the auto-merge window rides the armed merge unvalidated. Because the queue is
  high-churn, head-drift inside a merge window is the **normal case**, not a rare
  attack — arm-time-only validation on this ref is unacceptable.
- **CTX-002 — wrong trust signal.** A "trusted author" check on the PR would read
  the PR author (= the PAT owner), not the branch pusher, so it is meaningless as
  a trust signal for content that arrived via `assets/queue`.
- **CTX-003 — stale-base squash conflicts.** `assets/queue` is based on an older
  `main`; squash-merging a stale base can conflict with, or regress, art files
  that `main` received elsewhere.
- **CTX-004 — realign detection bug.** Driving "did the art already land?" off a
  three-dot `main...assets/queue` diff reports already-merged art **forever**
  after a squash merge (the merge-base is the pre-squash commit), so the PR would
  reopen in a loop.
- **CTX-005 — data-loss trap.** Resetting `assets/queue` to bare `main` after a
  merge (as the literal spec suggested) would silently drop edits that landed
  during the ~1h cycle — the exact loss vector the feature eliminates.

The maintainer reviewed the fork and **approved architecture A (sole-writer
promotion branch)** with three refinements, recorded here.

## Decision

**Land queued art through a sole-writer, bot-owned `assets/promote` branch that
is rebuilt on current `main` every cycle, and enforce trust on the diff
_content_ rather than on any author identity.** The reconciler is the only writer
of `assets/promote`.

Reconciler core = `scripts/sprites/reconcile-queue.ts` (IO-free, dependency-
injected `exec`/temp-dir/lock/`now`, mirroring the PR1
`queue-commit.ts` / `-runtime.ts` / `-cli.ts` split), wired by
`reconcile-queue-runtime.ts`, driven by `reconcile-queue-cli.ts`, and invoked by
the hourly `.github/workflows/sprite-queue-reconciler.yml` workflow.

### Cycle ordering (under `makeCheckinFileLock(repoRoot)`)

The reconciler holds the **same** repo-keyed cross-process check-in lock that
queue-commit takes, so a cycle and a concurrent dev-box queue-commit never race.

- **DEC-001 — cold-start probe.** `git ls-remote --heads origin assets/queue`;
  absent ⇒ `{status:'noop'}`, exit 0 (nothing to reconcile).
- **DEC-002 — fetch.** `git fetch --no-tags origin assets/queue main` (and
  `assets/promote` when it exists).
- **DEC-003 — two-dot art-surface delta.**
  `git diff --name-only origin/main origin/assets/queue -- public/assets/generated src/shared/data/sprite-catalog.json`.
  Empty ⇒ `{status:'noop'}`. Two-dot (**not** three-dot) is required: after a
  promote PR squash-merges, `main`'s art == queue's art ⇒ the two-dot delta is
  empty ⇒ steady-state noop. Three-dot would keep reporting already-merged art
  and reopen the PR forever (CTX-004).
- **DEC-004 — harvest onto current main (delta non-empty).** In a throwaway
  **detached** worktree checked out at `origin/main`, overlay ONLY the art
  surface from `origin/assets/queue`
  (`git checkout <queueRef> -- <ASSET_SURFACE_PATHS>`), `git add` the same
  allowlist, re-check `git diff --cached --quiet` (nothing staged ⇒ noop), then
  commit `--no-verify` with an injected-`now` message. Reuses PR1's
  throwaway-worktree machinery. A whole-surface `git checkout` of the fixed
  allowlist is used instead of PR1's per-asset `copyArtSurface` union: it gives
  the identical art-surface-only guarantee for a whole-surface harvest and
  preserves queue's already-unioned manifest verbatim, without needing a
  materialized source repo + discrete asset list.
- **DEC-005 — guard (defense-in-depth) on the staged diff.** `assertArtSurfaceOnly`
  over `git diff --cached --name-only origin/main`: every path must be in the
  art-surface allowlist (`public/assets/generated/**` PNGs + `manifest.json`, and
  exactly `src/shared/data/sprite-catalog.json`; traversal-safe — rejects
  absolute, drive-letter, backslash, and any `.`/`..`/empty segment). Because
  promote is built on current `main`, `merge-base(main, promote) == main`, so the
  two-dot guarded diff **is exactly** what the squash-merge lands. If the guard
  EVER sees a non-art path (structurally impossible — a path-escape or bug) it
  throws `untrusted-diff`, does **not** push/arm, and the workflow **escalates**
  (opens a security issue; CLI exit 30).
- **DEC-006 — force-update sole-writer promote.** Publish the harvested commit to
  `refs/heads/assets/promote` — a plain push on first create, else
  `git push --force-with-lease=refs/heads/assets/promote:<fetchedPromoteSha>`.
  The reconciler is the ONLY writer (workflow `concurrency:` single lane).
- **DEC-007 — open or update exactly ONE PR.**
  `gh pr list --head assets/promote --base main --state open`; create if none
  (idempotent — a create-race "already exists" is handled by re-querying and
  reusing), else edit the existing one. Never opens duplicates.
- **DEC-008 — arm auto-merge.** `gh pr merge <n> --auto --squash`. Result
  `{status:'pr-open', prNumber, created, armed:true, promoteCommit}`.
- **DEC-009 — do NOT reset `assets/queue`.** The harvest-onto-main model makes a
  reset unnecessary: next cycle overlays queue's (now-larger) art surface onto the
  freshly-merged `main`; when editing stops the delta goes to zero and the
  reconciler no-ops. Resetting queue to bare `main` would drop edits landed during
  the cycle (CTX-005). Queue is left accumulating; a race-safe
  `queue → main + its own art` tidy-up is **deferred to PR3**.

### Why architecture A closes the trust boundary

- **DEC-010.** Auto-merge is armed on `assets/promote`, whose **only** writer is
  the reconciler, which only ever force-updates it to a just-guard-validated,
  structurally-art-only commit built on current `main`. An untrusted push to the
  high-churn `assets/queue` can **never** ride the armed merge — the next cycle
  re-harvests + re-guards, and promote is never updated to an unguarded state.
  This eliminates the head-drift TOCTOU (CTX-001).
- **DEC-011.** Trust is enforced on the **diff content the reconciler produces**
  (structural harvest of a fixed allowlist + the guard), not on any author
  identity, so the wrong-trust-signal problem (CTX-002) is moot. Building on
  current `main` also makes `merge-base == main`, eliminating stale-base squash
  conflicts (CTX-003).

### Scoped CI-bypass (reuse, not blanket)

- **DEC-012.** The art surface enforced by the guard == `ASSET_SURFACE_PATHS` ==
  the art classification in `scripts/agent/ci/detect-art-only.sh` (wrapped by
  `npm run scope`), exactly. The `assets/promote → main` diff is art-surface-only
  by construction ⇒ the existing art-only classification already skips the heavy
  gameplay gates (headless Floor-1, weapon sweeps) for it, with the merge gate
  treating skipped as PASS. **No new blanket skip is added**; normal PRs are
  unaffected. The guard MAY additionally run as a merge-time check on the promote
  PR (defense-in-depth) — but the sole-writer promote branch is the primary
  guarantee, so this does not block on branch-protection config that cannot be set
  from the workflow.

### PAT identity & `action_required` stall avoidance

- **DEC-013.** The workflow authenticates with **`CRAWLER_CI_PAT`**, the same
  owner-scoped secret used by `ci-recovery.yml` / `merge-train.yml` /
  `auto-rebase-prs.yml`. It is a **classic user PAT (human identity), not a
  GitHub App token.** GitHub only parks a workflow run in `action_required` when
  the triggering push came from a **GitHub App** token, so the reconciler's
  PAT-identity push to `assets/promote` lets the promote PR's CI run normally and
  the armed auto-merge proceeds. The workflow therefore mirrors `ci-recovery.yml`
  (checkout `persist-credentials: false` + `gh auth setup-git` so `git push` uses
  the PAT), **not** `auto-rebase-prs.yml` (which uses an App token).

### Supersession of ADR 0066

- **DEC-014.** This reconciler is the new acceptance path for approved/edited
  sprite art and **supersedes the acceptance-flow portion of ADR 0066**
  (`0066-sidecar-owned-sprite-acceptance.md`) — specifically the old
  approve → `sprites:checkin` (push `asset/<slug>` + file an `asset-checkin`
  issue) → `sprites:asset-pr` (union the issues into one batch PR) union
  acceptance flow. ADR 0066's sidecar-owned **approve** operation, its
  per-instance loopback token, and its idempotency contract are unaffected. The
  old `asset-pr` union + `asset-checkin` issue flow is **not retired here** — that
  is PR3.

## Consequences

### Positive

- Queued sprite edits reach the shipped game automatically, on an hourly cadence,
  closing the "durable but never landed" gap left by PR1.
- The trust boundary is enforced on **content**, structurally: the reconciler can
  only ever land art, and an untrusted queue push can never ride an armed merge.
- Reuses PR1's proven throwaway-worktree + `makeCheckinFileLock` machinery and the
  existing art-only CI classification — no new merge-gate skip, no hand-rolled
  commit plumbing.
- Deterministic, real-git-tested core (temp bare origin + clone, in-memory `gh`);
  no `Date.now()` / `Math.random()` — `now` is injected.

### Negative

- Adds a second bot-owned branch (`assets/promote`) to reason about, and an hourly
  scheduled workflow burning a little CI time even when it no-ops.
- `assets/queue` grows unbounded until a PR3 tidy-up; the two-dot steady-state
  noop keeps this cheap but the ref accumulates history.

### Risks

- **Merge-time head-drift on `assets/promote` (accepted residual).** Auto-merge is
  armed with `gh pr merge --auto --squash --match-head-commit <promoteCommit>`, so
  the arm **aborts** if the promote head has drifted since we pushed it — but
  `--match-head-commit` validates only at **arm time**, not at the eventual merge.
  A push to `assets/promote` by anything other than the reconciler, landing between
  arm and merge, could still ride the armed merge. The **primary** defense is that
  the reconciler is the sole writer of `assets/promote` (single `concurrency:` lane,
  force-update-only) so no legitimate second writer exists; the guard re-runs every
  cycle. **Full merge-time enforcement requires a branch ruleset restricting pushes
  to `refs/heads/assets/promote` to the reconciler identity — recommended follow-up.**
  Per the maintainer decision we do **not** block PR2 on branch-protection config we
  cannot set here; the main-based single-writer promote branch is the accepted
  primary guarantee and this residual is explicitly accepted.
- **Fork-PR head-name collision (closed).** `gh pr list --head assets/promote`
  matches head by branch **name** across repositories, so a fork PR whose head
  branch is also named `assets/promote → main` would otherwise be edited + armed on
  its foreign diff. The reconciler discards any `isCrossRepository` PR (and any whose
  `headRefName` differs) and only ever reuses/arms a same-repo promote PR. Regression-
  tested (`(f) ignores a cross-repository (fork) PR`).
- **Sole-writer invariant is load-bearing.** If anything other than the reconciler
  force-updates `assets/promote`, the content-trust guarantee weakens. Mitigated by
  the workflow `concurrency:` single lane and force-update-only publishing; the
  branch-protection ruleset above is the durable follow-up.
- **PAT scope.** `CRAWLER_CI_PAT` has contents + PR write; a leak would let an
  attacker push to `main`. Same posture as the existing PAT-using workflows; not
  introduced here.
- **Guard is defense-in-depth, not the sole barrier.** It should be structurally
  impossible to trip (exit 30); if it ever does, the workflow fail-closes and opens
  an issue rather than merging. The guard matches directory surfaces on
  **descendants only** (never the bare directory path) so a whole-directory
  type-change cannot slip past it.

## Alternatives Considered

1. **Sole-writer promote branch rebuilt on current main (adopted, architecture A).**
   Chosen — closes the head-drift TOCTOU by construction and enforces trust on
   content, not identity.
2. **Literal `assets/queue → main` auto-merge with GraphQL `expectedHeadOid` +
   head-drift disarm (architecture B).** Rejected: still arms auto-merge on a
   mutable, high-churn ref; relies on per-head CI re-classification as a
   merge-time backstop and on disarm-on-drift races. Higher residual TOCTOU
   surface than a main-based single-writer branch for no simplicity win.
3. **Snapshot the raw `assets/queue` SHA onto promote (no rebuild on main).**
   Rejected: squash-merging a stale base can conflict with or regress art `main`
   received elsewhere (CTX-003), and the two-dot/three-dot diff mismatch persists.
4. **Reset `assets/queue` to `main` after merge (literal spec).** Rejected as a
   data-loss trap (CTX-005): the queue churns during the cycle and a reset would
   drop post-snapshot edits. Harvest-onto-main makes the reset unnecessary.

## Amendment (2026-08-03) — harvest-onto-main alone does NOT converge

Alternative 4 below rejected "reset `assets/queue` to `main` after merge" as a
data-loss trap and concluded that **"harvest-onto-main makes the reset
unnecessary."** That conclusion was wrong, and the cost was 104 consecutive
hourly runs that each opened a promotion PR.

Harvest-onto-main avoided CTX-004's three-dot bug, but the two-dot replacement
(`git diff --diff-filter=AM <main> <source>`) is still only a **"differs from
`main`"** test — not a "newer than `main`" test — and **nothing retires a
source**. With more than one source (the queue plus every orphaned
`assets/checkin-*` branch), whichever source currently _agrees_ with `main` drops
out of its own `AM` set, so the other source always wins the overlay and `main`
flips between them every cycle. Observed live: promote PRs #2704 and #2706, one
hour apart, carried an **identical 100-file set with exactly inverse patches**,
and 44 orphan branches (oldest 2026-07-08) were re-harvested every hour forever.

**Amended decision:** a promotion commit now records the **exact source tips it
harvested** (`Queue-Source:` / `Orphan-Source:` trailers), and the next cycle
retires precisely those snapshots once that promotion has **merged**. The reset
of alternative 4 is therefore adopted, but **only under a compare-and-swap
lease** (`--force-with-lease=refs/heads/<b>:<sha>`) plus a re-derived proof that
the source adds nothing to the current `main`. That closes CTX-005 exactly: an
edit that landed during the cycle moves the source tip, the lease misses, and the
source is left untouched. The queue-reset that was rejected as unconditional
data loss is safe precisely because it is now conditional on the recorded OID.

See `docs/knowledge/handoffs/2026-08-03-sprite-reconciler-convergence.md`.

## References

- Feature ADR (PR1 + scope split):
  [`2026-07-23-durable-asset-queue-persistence.md`](2026-07-23-durable-asset-queue-persistence.md)
- Superseded (acceptance flow only):
  [`0066-sidecar-owned-sprite-acceptance.md`](0066-sidecar-owned-sprite-acceptance.md)
- PR1 handoff: `docs/knowledge/handoffs/2026-07-23-sprite-queue-commit-pr1.md`
