# Handoff: Stop labelling non-conflicting PRs as conflict-managed

**Date:** 2026-07-28
**Session slug:** ci-conflict-false-labelling
**Apple estimate:** 3🍎
**Relates:** #2180
**PR:** ci-delivery-emergency-fix

## Systems touched

ci-policy

## Problem

The CI conflict coordinator was publicly marking PRs as conflicting with each other
when they demonstrably do not conflict. Five open PRs (#2114, #2108, #2101, #2003,
#1939) carried `ci-conflict-coordinated` / `ci-conflict-leader` / `ci-conflict-escalation`,
and the `*/5 * * * *` cron re-applied them after any manual cleanup.

This session began as an emergency response to a believed repo-wide 18-PR delivery
deadlock. **That premise turned out to be stale**, which is the most important finding
here — see below.

## Root cause

The clustering predicate in `.github/scripts/ci-conflict-coordinator/state.mjs` groups
PRs by **CI-filename identity** (the `fileOwners` map) and never performs any real
conflict test — no `git merge-tree`, no `mergeable` check, no content comparison. It
then amplifies that error through a **union-find transitive closure**, so one
high-traffic hub file (`ci-recovery/reconcile.mjs`, 2 963 lines, touched by 4 of 6
cluster members) welds unrelated PRs into a single blob.

Empirical refutation: `git merge-tree --write-tree` on grouped pairs sharing **zero**
CI files (e.g. #2108 vs #2114) exits `0` — clean. 7 of 15 live grouped pairs shared no
CI file at all. The predicate is neither sound (same file != conflict) nor complete
(#2123 vs #2146 were genuinely contradictory on _disjoint_ files and were never grouped).

`overlap()` in `state.mjs` is dead code — no callers. The live path is `fileOwners`.

## Key finding: the deadlock was already fixed

**PR #2168 merged at 2026-07-28T07:44:49Z** and made serialization opt-in. Verified
four independent ways:

| Check                                                                    | Result                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `coordinationEnforcementEnabled` in `main`                               | requires `CI_CONFLICT_COORDINATION_ENFORCE === '1'`                    |
| Workflow wiring (`ci-conflict-coordinator.yml:55`, `merge-train.yml:89`) | `${{ vars.CI_CONFLICT_COORDINATION_ENFORCE \|\| '0' }}` — defaults off |
| `gh variable list`                                                       | variable **not set** → enforcement **OFF**                             |
| Live PR labels                                                           | **zero** PRs carry `ci-conflict-order-wait` (the actual fencing label) |

No PR was being blocked. Only the labelling was still wrong, because
`addLabel(pull, COORDINATED_LABEL)` sat **outside** the kill switch.

This reduced the change from a risky retirement refactor to a ~30-line conditional.

## Change

`.github/scripts/ci-conflict-coordinator/reconcile.mjs` — in the group member loop:

- When enforcement is **on**: behaviour is unchanged (labels applied as before; the
  leader add/remove simply moved inside the enforced branch).
- When enforcement is **off** (the default): `COORDINATED_LABEL` and `LEADER_LABEL` are
  now **removed** alongside the already-removed `ORDER_WAIT_LABEL`. Removing rather than
  merely not-adding is what drains labels stranded by an earlier enforcing run.
- `ESCALATION_LABEL` now fires only on `ownershipGated` when unenforced. A
  `proof.status === 'ambiguous'` escalation is derived from group-mates, so it is
  meaningless once grouping is advisory; ownership gates (human approval, shepherd
  lease, corrupt ownership) are grouping-independent and are untouched.

## Why this is safe (each verified, not assumed)

- **No external consumer.** Grepped all of `.github/scripts/**` and `.github/workflows/**`:
  nothing outside `ci-conflict-coordinator/` reads `ci-conflict-coordinated` or
  `ci-conflict-leader`.
- **Not self-defeating.** `managedNumbers` (`reconcile.mjs:704`) is the union of
  `labeledManagedNumbers` (from labels, `:675`) **and** `commentedManagedNumbers` (from
  the coordinator comment, `:690-701`). Removing labels does not orphan PRs from future
  passes — the comment keeps them managed, so the drain loop at `:721` still works.
- **Dispatch de-duplication intact.** The coordinator comment is still written
  (`:953`); it is also the state store carrying `lastDispatchKey` / `lastDispatchAt`.
- **Recovery dispatch intact.** `ci-recovery.yml` is `workflow_dispatch`-only, but the
  _scheduled_ `ci-recovery-router.yml` dispatches it (`router.mjs:1189`, `:1301`), as do
  `auto-rebase-prs.yml` and the merge train (`reconcile-lib.mjs:259`).

## Validation

- `node --test .github/scripts/ci-conflict-coordinator/state.test.mjs .github/scripts/ci-conflict-coordinator/reconcile.test.mjs`
  → **47 tests, 46 pass, 0 fail, 1 skipped**.
- `node --test .github/scripts/merge-train/*.test.mjs` → **236 tests, 232 pass, 0 fail, 4 skipped**.
- Updated `coordinator discovers but neither serializes nor labels when enforcement is
disabled (default)` to assert the new contract: no `coordinated` label added, stranded
  `coordinated` label actively drained, and reporting still occurs via the coordinator comment.

## Follow-ups

The root defect (#2180) is **still open** — this change stops the false _labelling_, not
the false _grouping_. Detailed recommendation posted to #2180:

- Retire the grouping/fencing path; let the merge train be the single conflict authority.
- Any retirement must pass **both** `discoveredClusters: []` **and** `existingStates: []`
  — `mergeCoordinationGroups` seeds from every persisted state and merges seeds sharing
  any PR number transitively, so dropping only one leaves the blob intact.
- Duplicate-closing can be re-homed group-free: its real gate only closes PRs that are a
  no-op against **main alone** (`proof.predecessorHeads.length === 0`), so per-PR
  supersession proofs give an identical verdict.
- Residual cleanup: `overlap()`, `clusterPullRequests`/`discoverCoordinationClusters`,
  `merge-train/ci-conflict-order.mjs`, the `CI_CONFLICT_COORDINATION_ENFORCE` knob + its
  `ci-config-knobs.md` row, and leftover `CI_CONFLICT_ORDER_WAIT_LABEL` consumers.

### Known residual (issue #2183, escalated in the review ledger)

`ci-conflict-escalation` is an **accidental CI-recovery dispatch fence**:
`DISPATCH_BLOCKED_LABEL_NAMES` (`ci-recovery/router.mjs:115-122`) blocks it but does
**not** block `ci-lifecycle-quarantined` / `ci-lifecycle-abandoned`
(`ci-recovery/pr-lifecycle.mjs:46-47`). So the escalation label is the only thing keeping
a quarantined/abandoned PR from consuming a dispatch slot.

Because of that, the all-non-blocking early-exit path deliberately does **not** drain
`ESCALATION` — draining it would re-expose those PRs to dispatch. The consequence is that
a grouping-derived escalation can never drain once every group member is quarantined or
abandoned.

This is **pre-existing, not a regression**: before this change that path drained _nothing_.
The correct fix changes CI-recovery dispatch eligibility, which deserves its own review,
so it is tracked in #2183 rather than smuggled into this minimal patch. The review ledger
records this as `escalated_to_human` after round 2 rather than claiming a clean loop.

### Duplicate-PR investigation (#1939 vs #2003)

An earlier recommendation to close #1939 as superseded by #2003 was **wrong, and wrong
for the same reason as the coordinator bug** — it was based on filename overlap rather
than content. Corrected finding:

- `bamboo-fed-berserk` is **already merged in main** (#1960, `d725bcf95`), so #2003's
  ~20 gameplay files are contamination, including `4e009b960` — a re-landed copy of an
  already-merged squash.
- `check-exact-deps.mjs` is in **neither** PR's merged state; #2003 has the later, fixed
  version (strict SemVer regex, injectable exemptions, `fileURLToPath` path resolution).
- Decontaminating #2003 via `git rebase --onto origin/main` fails on genuine
  `package.json` / `package-lock.json` conflicts.
- **Neither PR was closed.** #1939 is the simpler landing candidate (3 clean commits);
  #2003's guard improvements should be ported onto it.

## Gotchas for the next agent

- The coordinator integration tests **do** run on Windows (~95 s). Always check the
  `# skipped` count — some invocations skip on a `UV_HANDLE_CLOSING` crash, and a naive
  "no failures" read is dangerously misleading (an early run here reported
  `pass 0, fail 0, skipped 14`).
- `npx eslint` on `.github/scripts/**` emits ~76-138 bogus `'process' is not defined`
  errors for **any** file there, including untouched ones — `npm run lint` only covers
  `src/ tests/ scripts/`. Compare against an untouched control file before believing it.
