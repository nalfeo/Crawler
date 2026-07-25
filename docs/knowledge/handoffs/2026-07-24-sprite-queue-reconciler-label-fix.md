# Sprite-queue reconciler: fix merge-train label enrollment gap

## Systems touched: sprite-pipeline, sprite-workflow

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. Tooling cap (3🍎) not even reached: a
single existing file (`scripts/sprites/reconcile-queue.ts`) plus its test
extension, no new module/system, no lab needed. Per
`docs/agent-os/policies/complexity-policy.md`, 2🍎 requires no plan/code
review stages and no `apples:record` entry. A tier-only review ledger was
still initialized/validated per policy:
`docs/knowledge/review-ledgers/2026-07-24-sprite-queue-reconciler-label-fix.review-ledger.json`.

## Context

Follow-up to PR2 (#1916, merged to `main` as
`093473da95366bb67e952a4e686728f9f8f6493f`,
see `docs/knowledge/handoffs/2026-07-24-sprite-queue-reconciler-pr2.md` and
`docs/knowledge/adr/2026-07-24-sprite-queue-reconciler.md`), which shipped
the hourly `scripts/sprites/reconcile-queue.ts` reconciler that opens
`assets/queue → assets/promote → main` promotion PRs and arms
`gh pr merge --auto --squash`.

## The bug (verified)

`main`'s ONLY merge gate is the "Merge Train Required Checks" ruleset,
requiring status contexts `ci` and `merge-train`. The `merge-train` status is
posted only by the merge-train GitHub App **after** it admits a PR into the
train, and admission is gated on the PR carrying the `merge-train` **label**
(`QUEUE_LABEL` in `.github/scripts/merge-train/state.mjs:3`; enrollment
predicate `pr.labels.some(l => l.name === QUEUE_LABEL)` at `state.mjs:90`).

There is no auto-labeler workflow for `assets/promote` PRs anywhere in the
repo (confirmed by searching for `.github/workflows/*label*` and any
reference to `assets/promote` outside `sprite-queue-reconciler.yml`). #1916
itself was hand-labeled by the repo owner. The reconciler's `gh pr create`
(create path) and `gh pr edit` (update path) never applied the label.

**Consequence**: every `assets/promote` PR passes `ci`/security checks and
arms `--auto --squash`, but never receives the `merge-train` status → sits
`BLOCKED` forever → queued sprite art never lands on `main`. This defeated
the entire PR2 feature end-to-end.

## The fix

In `scripts/sprites/reconcile-queue.ts`:

1. Added `MERGE_TRAIN_LABEL = 'merge-train'` and applied it unconditionally
   on the `gh pr create` argv (create path) — a brand-new PR can never carry
   any train-revocation label yet, so it's always safe.
2. On the update path (existing open PR), `findOpenPromotePr` now also
   returns the PR's current label names (extended `--json` fields to include
   `labels`, normalizing `gh`'s `{name}` objects to `string[]`). Each
   reconcile cycle **re-ensures** `merge-train` via
   `gh pr edit <n> ... --add-label merge-train`, folded into the same edit
   call that already updates title/body. This re-ensure is required (not
   one-time) because #1916's event log shows `crawler-ci[bot]` stripping the
   `merge-train` label mid-cycle.
3. Added `MERGE_TRAIN_RE_ENSURE_EXCLUDE_LABELS` — a widened exclusion set
   (not just the terminal `merge-train-landed` label from the first draft
   plan, which the human reviewer correctly flagged as too narrow):
   - `merge-train-blocked` / `merge-train-recovery-pending`: the train
     **deliberately removes** `merge-train` when it sets either of these
     (confirmed in `.github/scripts/merge-train/reconcile-lib.mjs`'s
     `applyLandedRecoveryDecision` and the blocked/retry paths in
     `reconcile.mjs`). Re-adding `merge-train` here would fight an
     intentional train decision.
   - `merge-train-noop` / `merge-train-validation-failed`: always set
     **alongside** `merge-train-blocked` in the same call
     (`reconcile.mjs`), so excluding on `blocked` alone would already cover
     these — but explicit constants were added for self-documentation and to
     not silently depend on that co-occurrence continuing to hold.
   - `merge-train-landed`: the one **permanent** label (only ever added,
     never removed per `state.mjs`'s own comment) — terminal, so the skip is
     effectively final for that PR.
   - The skip is per-cycle only for the non-terminal labels; the reconciler
     re-evaluates fresh label state every hourly run.
4. Did **not** add `human-approval-required` anywhere (that's an opt-in gate
   requiring a human `APPROVED FOR CHECK-IN` comment; automated promote PRs
   must not carry it).
5. Everything threads through the existing injected `deps.exec` — no new IO,
   no `Date.now()`/`Math.random()`.

No auto-labeler workflow was found to prefer/extend (re-verified per the
task instructions before writing new code).

## Test coverage

Extended `tests/unit/sprites/reconcile-queue.test.ts`:

- `FakeGh`/`FakePr` now track `labels: string[]`; `create` accepts `--label`,
  `edit` accepts idempotent `--add-label`; `seedOpen` accepts an optional
  labels array.
- New regression tests in the `runReconcile (real git)` describe block:
  - `(i)` — create path: new PR's argv includes `--label merge-train`, and
    never carries `human-approval-required`.
  - `(j)` — update path, existing PR has no exclusion label (simulating
    `crawler-ci[bot]` having stripped `merge-train` mid-cycle): each cycle
    re-adds `merge-train` via `--add-label`.
  - `(k)` — update path, existing PR carries `merge-train-blocked`: the
    re-add is **skipped** this cycle.
  - `(l)` — update path, existing PR carries the terminal
    `merge-train-landed`: the re-add is skipped (permanent case).

All 31 tests in the file pass (27 pre-existing + 4 new).

## Local verification (npm-proxy workaround)

Per PR2's precedent, `npm ci`/`npm install` in this worktree cannot resolve
some deps (e.g. `postcss`) through the corp proxy registry
(`packagefeedproxy.microsoft.io`), and direct `registry.npmjs.org` access is
blocked at the TLS layer. Rather than relying solely on CI, this session
verified logic locally with a working standalone repro:

- A scratch npm project (outside the repo, `~/temp-tsc-check`) installed
  `typescript@5.7`/`@types/node@22` (both available via the proxy) to
  standalone-typecheck the two changed files — 0 errors.
- The same scratch project installed `vitest@4.1.8` (matching the repo's
  pinned `^4.1.8`) and `prettier@3`. The repo's (mostly-empty, npm-ci-failed)
  `node_modules` was temporarily swapped for a Windows directory **junction**
  pointing at the scratch `node_modules`, allowing the real
  `vitest.config.ts` (`projects: [...]`, `sprites` project) to run
  unmodified: `vitest run --project sprites tests/unit/sprites/reconcile-queue.test.ts`
  → **31/31 passed**. `prettier --config .prettierrc --write` was run on both
  changed files (reformatted `reconcile-queue.ts`; test file was already
  compliant); tests were re-run after formatting and still passed 31/31.
  The junction was removed and the original `node_modules` restored
  immediately after each run.
- Full-repo `npm run typecheck`/`npm run lint` were **not** replicated
  locally (would require installing the entire eslint/typescript-eslint
  config graph plus all `@types` for the codebase) — relying on CI as
  authoritative for those, consistent with PR2's handoff. The scratch
  `~/temp-tsc-check` directory was deleted at the end of the session.

## PR / merge

Non-draft PR opened from `nalfeo-friendly-succotash` → `main`, labeled
`merge-train` at creation time (the PR itself needs the same label to enroll
in the train and merge). `human-approval-required` was not added.
`gh pr merge --auto --squash` armed after creation.
