# ADR: Durable approved-asset persistence via a long-lived `assets/queue` branch

## Status

Accepted

## Date

2026-07-23

## Estimated Complexity

🍎 x 5 — spans the sprite sidecar, approve CLI, the canvas sprite-editor
extension, and the devtools workflow UI, and it changes shipped manifest game
data, so the tooling-only apple cap does not apply. This ADR covers the whole
feature; **PR1** (this session) lands the load-bearing queue-commit primitive and
its two callers.

## Context

Sprite anchor/metadata edits authored through the canvas sprite-editor extension,
the gallery `/approve` route, or a revert are written straight into the committed
generated **manifest** + catalog + PNG (the runtime reads only those —
`preload.ts` 155-179, `PhaserBridge.ts` 920-956 — and ignores any run-store
sidecar). The acute loss vector: **nothing auto-commits those writes.** An edit
made in a Copilot worktree/session that is not manually committed is discarded
when the worktree is torn down, so the maintainer repeatedly loses hand-tuned
anchors across sessions/worktrees/processes.

The existing publish path (approve → `sprites:checkin` pushes `assets/<slug>` and
files an `asset-checkin` issue → `sprites:asset-pr` unions the issues into one
batch PR) is also structurally lossy: the union overlays a later branch's whole
manifest over an earlier one (can revert an earlier asset's update), and a mutable
per-asset issue/branch can be closed by a batch that snapshotted an older revision.

An **adversarial plan review** (gpt-5.6-sol) returned `major_fork` / RECONSIDER and
recommended collapsing the per-asset-branch fan-out into a single durable queue,
with the manifest as the sole source of truth.

## Decision

**The manifest is the sole authority; git is the queue.**

1. **Queue-commit primitive** (`scripts/sprites/queue-commit.ts`, IO-free core with
   dependency-injected `exec`/`fs`, mirroring the `checkin.ts` /
   `checkin-runtime.ts` split so it is unit-testable). Given the repo root, the set
   of changed art-surface files (manifest.json, sprite-catalog.json, one or more
   `public/assets/generated/<id>.png`) and a message, it lands a commit on the
   **persistent remote `assets/queue` branch and pushes it, without touching the
   caller's working branch, index, or HEAD.**
   - Mechanism = **throwaway detached worktree reuse**: inside
     `makeCheckinFileLock(repoRoot)` (the same cross-process lock the sidecar
     approve route and the editor's tsx CLI already take), a bounded retry loop
     fetches `origin/assets/queue` (falling back to `origin/main` when the queue
     branch does not yet exist), adds a detached worktree at that tip, unions the
     live repo's changed art surface onto it via the proven `copyArtSurface`
     (`mergeManifests`/`mergeCatalogs`), stages **only** an asset-surface path
     allowlist (rejecting `..`/absolute), no-op-guards on `git diff --cached
--quiet`, commits `--no-verify`, and **CAS-pushes** the new commit with a **plain
     fast-forward-only push** (`git push <remote> <sha>:refs/heads/assets/queue`,
     NOT `--force-with-lease`; a plain create push when the branch is new). Because
     the commit's parent is the fetched tip, a concurrent advance makes the push a
     non-fast-forward and git rejects it. On a non-ff rejection it re-fetches and
     re-unions against the new tip, so a concurrent writer's _different_ entry is
     preserved rather than clobbered (a plain push can never overwrite a concurrent
     update — that is the compare-and-swap). The worktree is always removed in `finally`.
   - `queue-commit-runtime.ts` wires real `execFile`; `queue-commit-cli.ts` is a
     thin JSON CLI so the `.mjs` extension (which cannot import TS) can shell out
     to the one tested implementation via `tsx`.
2. **Callers routed through the primitive:** the sidecar approve route + `approve-cli`
   (same-process TS import, inside the existing mutation lock) and the canvas
   editor `saveSprite` (shells the CLI after its write). Approved/edited assets are
   therefore durable on the remote the instant the mutation succeeds.
3. **PR1 stays local-only** — the queue push happens from the dev box with the
   dev's git creds. No auto-merge, CI bypass, PAT, or trust boundary in PR1; those
   move to PR2.
4. **UI honesty:** approve/editor/revert surface a **failed** queue push to the
   operator (the response carries a `queueCommit` / `queue` status) instead of
   silently reporting success, so a durability failure is never hidden — including
   when the operator navigates away or reselects a queue item while the
   seconds-long push is in flight.

### Scope split (per maintainer)

- **PR1 (this session):** the queue-commit primitive + the approve/editor/revert
  callers + failure surfacing.
- **PR2:** an hourly cron reconciler that opens/updates ONE `assets/queue → main`
  PR, arms auto-merge, and resets the branch post-merge, plus the CI-bypass flag +
  PAT + trusted-author/base=main/diff-allowlist guard. Supersedes the ADR
  0066 (`0066-sidecar-owned-sprite-acceptance.md`) acceptance flow.
- **PR3:** retire the old `asset-pr` union + `asset-checkin` issue flow and update
  its consumers (workflow extension UI, `asset-forge` / `sprite-issue-factory`
  agents, the `asset-pr` skill, `sprite-approval-api.ts`, tests).

## Consequences

### Positive

- Approved and hand-edited assets become durable across sessions, worktrees,
  processes, and branches the moment the mutation succeeds — closing the acute
  edit-loss vector.
- The union-onto-refetched-tip merge makes the whole-manifest-clobber class
  (batch-union finding) structurally impossible at the commit level; concurrent
  writers touching different entries both survive.
- The art-surface path allowlist means the queue branch can only ever contain
  art-surface diffs, pre-satisfying PR2's merge trust boundary.
- Reuses proven `checkin.ts` plumbing (`copyArtSurface`, `git()` helper,
  `makeCheckinFileLock`) rather than hand-rolling commit-tree plumbing.

### Negative

- Every approve/editor save now performs a network push (bounded retry). Latency
  is dominated by the push, not the local worktree add.
- The `.mjs` editor caller shells out to a `tsx` CLI subprocess (the `.mjs` cannot
  import TS); adds a process hop on save.

### Risks

- **Concurrent same-repo same-entry writes** are last-writer-wins by design
  (documented); **concurrent same-repo different-asset manifest read-modify-write**
  outside the git lock remains a pre-existing race, **deferred** to a dedicated
  locking-hardening follow-up (not introduced by PR1).
- A `tsx`/`node_modules` regression would break the editor caller; mitigated by the
  sidecar launcher already depending on `tsx`.
- The operator status line is transient; a surfaced durability warning can be
  overwritten by a later `Ready.` on a concurrent switch. A sticky durability
  banner is a possible small follow-up, not a PR1 blocker.

## Alternatives Considered

1. **Manifest = sole authority (adopted).** Keep the runtime-effective manifest as
   the single source of truth and make its git persistence automatic. Chosen —
   least new surface, no new read path, no sidecar reconciliation.
2. **Run-store sidecar as authority + reconcile into the manifest.** Rejected: the
   runtime ignores sidecars, so it adds a second source of truth and a
   reconciliation step with no runtime benefit.
3. **Single long-lived `assets/queue` branch, git = queue (adopted).** Rejected the
   per-asset-branch fan-out (`assets/<slug>` + issue) because its batch union is
   lossy and its mutable per-asset issue/branch can be closed against a stale
   snapshot.
4. **Hand-rolled commit-tree plumbing with re-parent on retry.** Rejected by the
   confirming review: re-parenting on CAS retry clobbers a concurrent writer's
   whole-manifest snapshot (CAS protects the ref, not the JSON). The
   worktree-reuse + union-onto-tip mechanism preserves concurrent entries.
