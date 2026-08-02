# ADR 0082: Deterministic controls for the top regression classes

## Status

Accepted

## Date

2026-08-02

## Estimated Complexity

🍎 x 3 — tooling-only (guards, health checks, lint rule, CI wiring); capped at 3🍎 per
the complexity policy's tooling ceiling. No runtime gameplay behavior changes.

## Context

A retrospective over the last 20 regressions that required a human, a PR shepherd, or
CI-recovery ("CI god admin") to intervene found that they are not 20 independent bugs.
They are **7 recurring mechanisms**:

| Class | Mechanism                                  | Incidents |
| ----- | ------------------------------------------ | --------- |
| A     | Merge-resolution data loss                 | 6         |
| B     | Automation state loss / liveness           | 5+        |
| C     | Guard false positives                      | 5         |
| D     | Schema / data-contract drift               | 7         |
| E     | Parallel-PR collisions                     | 2+        |
| F     | Visual defects invisible to numeric guards | 4         |
| G     | Environment / tooling drift                | 3+        |

Classes A–D alone account for roughly 18 of the 20 interventions.

The decisive observation is that **each of these was caught by a person, late**, and that
roughly a third of the interventions closed without leaving behind either a deterministic
check or a dated accepted-risk entry. That is precisely why the same classes kept
recurring: the knowledge lived in handoff prose, not in an exit code.

Representative receipts:

- **A** — PR #2022's main-merge silently discarded Don Paco boss-ability rows; PR #2365's
  merge lost an upstream `test-only-exports.ts` wrapper. Both were reconstructed by hand.
  A v2 conflict fix used `-X theirs` and clobbered an agent definition file.
- **B** — a re-thrown non-422 `update-branch` error crashed the reconciler mid-loop and
  deadlocked the merge queue for ~90 minutes.
- **C** — the `test-only-exports` guard false-positived three separate times, costing as
  much agent time as a real bug would have.
- **D** — 55 welcome-room shards kept stale `contentHash` values after their PNGs were
  restored; a Floor-2 achievements tier collided with a sibling PR; Floor-2 item art fell
  back to text placeholders because a lookup keyed on `slug` instead of `stableId`.
- **G** — a workflow extension silently failed to load because of a bare import that is
  unresolvable in the sandboxed extension host.

## Decision

Convert the five highest-yield classes into **deterministic checks with exit codes**, wired
into `verify:fast` (edit-time) and CI (merge-time). No LLM judges; every control is a
script that passes or fails.

### 1. Class D — `check:registry-integrity`

Validates registry JSON for duplicate, blank, or non-string ids **within** a file and,
critically, **across sibling files that share one logical id namespace**
(`achievements.floor1.json` + `achievements.floor2.json`). Per-file Zod loaders
structurally cannot see the cross-file case — that blind spot is what produced the Floor-2
tier collision that needed a human escalation.

This is deliberately scoped as an **ID-integrity slice of class D, not a solution to all of
class D.** Field/type/version drift and consumer-vs-schema disagreement remain uncovered;
schema-derived fixtures (below, in Alternatives) are the larger remaining piece and are
named as the top follow-up. The ID check was sequenced first because it closes the
specific sub-case that produced an escalation-grade failure.

### 2. Class D/F — `check:asset-integrity`

Verifies the shard ↔ PNG ↔ `contentHash` triple over the **entire committed corpus** (641
shards, 516 hashes), not just newly added entries. Running corpus-wide is the point: a
latent defect is then found once, deterministically, rather than eventually by eye. On its
first run it immediately found a real orphan — `rhea-vale-v1-var-0-walk.json`, a shard
whose PNG was intentionally deleted by PR #2322 and which was silently resurrected by a
later chore commit (#2663). That is a class-A silent revert that had been sitting on main
undetected.

### 3. Class A — local silent-revert gate + blunt-strategy guard

`check:silent-reverts` already existed but ran **only in CI, only on `pull_request`** — it
was purely post-hoc, which is exactly why #2022 and #2365 needed humans. It now also runs
in `verify:fast`, gated by a new `scripts/agent/ci/merge-scope.sh` that emits
`has_merge` / `can_run`, so:

- a linear branch (the common case) pays nothing;
- a branch containing a merge commit is checked the moment the merge is made;
- a shallow clone or unresolvable base **skips with actionable text and never fails** —
  a local checkout state is a tooling condition, not a branch defect, and CI re-runs the
  guard with `fetch-depth: 0` regardless, so skipping locally cannot weaken the gate.

Separately, a `shell-blunt-merge-strategy` copilot guard denies `git merge -X theirs` /
`-X ours` at the tool-call boundary. Side-wholesale conflict resolution is what makes
class-A data loss possible in the first place.

### 4. Class C — `check:allowlist-expiry`, and a guard-authoring contract

Generalizes the pre-existing knip/npm-audit expiry precedent to **every** allowlist,
suppression, and exception list. Each entry must carry a specific reason plus either an
unexpired `expiresOn` (`time-bounded`) or a tracking reference and removal condition
(`tracked-permanent`). It is **fail-closed**: an allowlist-shaped export that is not
registered is itself a finding, so a new allowlist cannot silently escape governance.

The companion half of this class is a rule about how guards are written, demonstrated by
the ESLint rule below: **a guard must prove it does not false-positive.** Concretely,
every guard ships negative-control cases — inputs that are pre-existing or legitimate and
must NOT be reported.

### 5. Class B — `crawler/no-rethrow-in-automation-catch`, narrowed to loop scope

An ESLint rule over `.github/scripts/merge-train/**` and `.github/scripts/ci-recovery/**`
replacing a brittle one-off source-string test.

The rule reports a rethrow **only when the `catch` is lexically inside a loop body with no
intervening function boundary**. This narrowing is the whole design:

- the un-narrowed "any rethrow in a catch" version reported **24** sites, 23 of which were
  ordinary helper-level error plumbing — it would have been a textbook class-C guard;
- the narrowed version reports **1**, and that one is the real thing: a throw escaping a
  `for (const pr of queued)` loop does not merely fail one PR, it **abandons every
  remaining queued PR**, which is exactly the 90-minute deadlock.

The live `reconcile.mjs` bug is also fixed. Novel statuses are **not** silently swallowed:
they are logged with a distinct, greppable `unexpected-status:` marker and the loop
continues, so visibility is preserved without crashing the reconciler. The
previously-existing test that asserted the buggy `throw err` behavior was updated to pin
the new contract.

## Consequences

### Positive

- Five recurring intervention classes now fail an exit code instead of a person's
  attention, at edit time rather than after review.
- Two **real latent defects on main** were found by the new checks during this very change:
  the orphaned `rhea-vale` shard and two bare-import violations in the `asset-search`
  extension (a live instance of the class-G "extension silently not loading" regression).
- The merge queue's most expensive known failure mode is closed both at the specific call
  site and structurally, by a lint rule that prevents its reintroduction anywhere in the
  automation trees.
- Governance is now uniform across all allowlists, and fail-closed, so the "an exception
  quietly expired on a date nobody watched" failure cannot recur silently.

### Negative

- `verify:fast` gains three checks. Measured cost is well under one second total (asset
  integrity is ~90–300 ms over 641 shards); all three are pure file reads with no sim, git,
  or subprocess work.
- One more lint rule to reason about in the automation trees, with one documented
  `eslint-disable` escape hatch already in use (`requestWithBackoff`, a retry loop over
  attempts at a single request, where propagating on the final attempt is the contract).

### Risks

- **The loop-scope narrowing can miss real shapes.** A rethrow in a helper _called from_ a
  loop (e.g. `removeLabel()` inside the queue loop), or a batch expressed as
  `Promise.all(items.map(...))` rather than a loop node, is not reported. This is a
  deliberate precision-over-recall trade to avoid shipping a class-C guard, and lexical
  ESLint analysis structurally cannot enforce the full invariant. A runtime per-item
  boundary (`forEachSafe` / `Promise.allSettled`) is the named follow-up that would close
  the gap properly.
- **Fail-closed allowlist registration could itself false-positive** on a newly added
  allowlist-shaped export. Mitigated by a specific error message naming the registration
  step. Registration is keyed on `file#exportName` rather than a bare name — an earlier
  name-only version meant any new `export const ALLOWLIST` silently inherited the
  orphaned-systems registration, which was a straight bypass of a rule whose whole purpose
  is to be fail-closed. Discovery also scans only `scripts/` and `.github/scripts/`, so the
  "every allowlist in the repo" guarantee is really "every allowlist in the automation
  roots"; widening the scan is a follow-up.
- **Expiry dates can be bumped without restating the reason.** `check:allowlist-expiry`
  validates only the _current_ state of a time-bounded entry, so an unexpired date always
  passes and nothing detects the same reason being carried forward under a fresh deadline —
  the exact "extend it again" failure the remediation text forbids in prose. The npm-audit
  and Knip guards already compare against the base revision; giving this check the same
  base-ref diff (reject an increased `expiresOn` whose `reason` is byte-identical) is the
  named follow-up. Raised by the separate-model code review and deferred as its own change
  because it needs base-revision plumbing that does not exist in this checker.
- **A persistently failing oldest PR still blocks FIFO admission.** The `break` after a
  BEHIND PR is intentional ordering (newer PRs must not leapfrog), so a PR that fails
  `update-branch` every cycle will keep blocking admission. This is pre-existing behavior
  and is strictly improved by this change — previously the same condition _crashed the
  whole reconciler_, now only admission pauses and it self-recovers on the next pass — but
  a durable "permanently poisoned entry" classifier with escalation is still needed to
  satisfy the liveness invariant "queued ⇒ progressing".
- **Corpus-wide asset checking is not a full pixel-identity guarantee.** 125 of 641 shards
  legitimately carry no `contentHash` and are therefore not hash-verified, and a shard whose
  hash was updated alongside wrong pixels still passes. This control covers identity/staleness,
  not visual correctness; genuine class-F structural metrics remain deferred.
- Corpus-wide asset checking will surface further pre-existing latent defects. That is the
  intent, but it means the first CI runs after this lands may be red for reasons predating
  the change. The correct response is to fix the defect, never to allowlist it.

## Alternatives Considered

- **Schema-derived test fixtures (Zod default factories) instead of registry ID checks.**
  Strictly better for the "adding a required field reds every fixture" sub-case (#4, #7)
  and still worth doing, but it does not address cross-file id-namespace collisions, which
  is the sub-case that actually required a human escalation. These are complements; the ID
  check was chosen first because it closes the escalation-grade failure. Fixture derivation
  remains the highest-value follow-up in class D.
- **A pre-commit/pre-push git hook for the silent-revert gate** rather than `verify:fast`.
  Rejected: hooks are bypassable with `--no-verify`, are not installed uniformly across
  agent sessions, and would fire on every commit rather than only on branches that actually
  contain a merge. `verify:fast` is the command agents are already required to run.
- **A runtime `forEachSafe` wrapper that structurally cannot throw**, instead of a lint
  rule. More robust in principle — it makes the bug unrepresentable rather than merely
  detectable — but it requires rewriting every batch loop in the automation trees, which is
  well beyond a 3🍎 tooling scope and carries its own regression risk in the exact code
  path whose reliability is at issue. The lint rule is the low-risk first step; the wrapper
  is a reasonable follow-up.
- **Keeping the source-string test** that asserted `throw err` was present. Rejected: it
  pinned the buggy behavior, tested one call site by substring matching, and would silently
  stop protecting anything the moment the surrounding code was reformatted.
- **Deferred: class E (parallel-PR collision radar) and class F (structural image
  metrics).** Both are real and both are in the retrospective's ranked plan, but each is
  its own multi-apple change — E needs cross-PR state at PR-open time, F needs new image
  analysis. Deferring them keeps this change inside its tooling-only 3🍎 ceiling rather
  than producing a large, weakly-reviewed batch.
- **Doing nothing / relying on review vigilance.** This is the status quo that produced 20
  interventions. Explicitly rejected: roughly a third of those interventions closed without
  adding any check, which is the mechanism by which the classes recur.
