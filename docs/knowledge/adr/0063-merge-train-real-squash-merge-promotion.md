# ADR 0063: Merge-Train Real GitHub Squash-Merge Promotion (MERGED Completion Semantics)

## Status

Accepted

## Date

2026-07-15

## Estimated Complexity

🍎 x 6 — production merge-orchestration change that replaces the promotion
mechanism, adds a fail-closed post-merge proof, idempotent crash recovery, and
downstream mapping, and amends two accepted ADRs. Larger than a pure promotion
swap because it touches the safety model (exact-SHA → validated-tree-equivalence)
and the completion-signal contract that four prior gap-fix sessions built on.

## Context

- **CTX-001**: ADR 0060 (DEC-006) asserted that promoting by an atomic
  multi-ref `git push --force-with-lease` of the validated candidate SHA onto
  both `main` and every PR head ref would keep "individual merged-PR semantics"
  (POS-003: "each PR still contributes one final commit and remains recorded as
  merged by GitHub").
- **CTX-002**: That assertion is **false**. GitHub sets a PR's `merged` /
  `merged_at` / real `merge_commit_sha` **only** when the PR is closed through
  GitHub's own merge machinery (its Merge API or the web "Merge" button). An
  atomic force-push bypasses that machinery entirely, so GitHub auto-closes each
  promoted PR (`state: closed`) but **never** records it merged. Verified live on
  2026-07-15: seven train-promoted PRs (#1087, #1092, #1099, #1140, #1141,
  #1147, #1149) all show `merged: false, merged_at: null` despite their commits
  being present on `main`. #1149 is the canonical regression fixture (train
  commit `c8c57f8` landed; PR state `closed`, `merged:false`,
  `merge_commit_sha` is an ephemeral test-merge SHA, not the landed commit).
- **CTX-003**: ADR 0062 DEC-024/DEC-025 adapted to CTX-002 by making the
  promotion **confirmation predicate** accept `state === 'closed'`
  (`isPostPushConfirmationSatisfied`). That is a durable acceptance of the
  forbidden outcome: the maintainer's hard requirement is that every future
  landed train PR end GitHub `state = MERGED` with a **non-null real**
  `mergeCommit`; the CLOSED-plus-label pattern is explicitly forbidden as the
  future-state solution.
- **CTX-004**: The same force-push also silently broke downstream reporting:
  `deploy.yml`'s "released" labeler (`gh pr list --state merged`) misses
  force-pushed train PRs, and its baseline-win-rate commenter plus
  `manual-preview.yml` (`gh api commits/$SHA/pulls`) resolve nothing for a
  force-pushed commit, because GitHub never associated the PR with a merge.
- **CTX-005**: A GitHub repository **ruleset** ("Merge Train Required Checks",
  ADR 0062) grants the trusted Crawler CI App `bypass_mode: always`. Verified
  live: PR #1131 was squash-merged by `crawler-ci[bot]` through GitHub's own
  merge machinery **while the ruleset was active**, producing a genuine `merged`
  event with a real merge commit. This proves the App's bypass covers the merge
  API — the capability this decision depends on.
- **CTX-006**: GitHub's native merge queue remains unavailable to this
  repository (ADR 0060 ALT-001/002) and must not be used or suggested.

## Decision

- **DEC-001**: Replace the atomic multi-ref force-push promotion with
  **sequential GitHub squash-merges**, one per admitted PR in candidate order,
  performed by the trusted App via `PUT /repos/{o}/{r}/pulls/{n}/merge`
  (`merge_method: squash`). GitHub therefore records each PR with
  `merged: true` and a real merge commit — the required completion semantics.
- **DEC-002**: **Amend ADR 0060 DEC-005/DEC-006 (and POS-001/POS-003)**: the
  promotion invariant changes from "`main` advances only to the exact validated
  candidate SHA" to "`main` advances only to a **GitHub-generated commit whose
  tree is proven identical to the corresponding validated candidate prefix**."
  A server-side squash necessarily creates a new commit SHA (different
  committer/parent/timestamp), so exact-SHA equality is impossible; tree
  equality is the achievable, equivalent content invariant, and CI is
  deterministic on tree content.
- **DEC-003**: **Amend ADR 0062 DEC-025**: retire the `state === 'closed'`
  confirmation predicate (`isPostPushConfirmationSatisfied` /
  `createWaitForMergedPr`, both removed). Completion is now proven by GitHub's
  real `merged: true` + `merged_at`, never by `closed` alone, and never by a
  non-null `merge_commit_sha` alone (it can be an ephemeral test-merge SHA).
- **DEC-004**: Every landed commit passes a **fail-closed post-merge proof**
  (`landedCommitProofError`) before any durable landed signal is written:
  (a) the merge response returned `merged: true` + a valid SHA; (b) `main` now
  equals that SHA; (c) the landed commit has exactly **one** parent equal to the
  expected base (linear history preserved); (d) the landed commit's tree equals
  the validated candidate prefix's tree; (e) a re-fetch of the PR shows
  `merged: true` with a `merged_at` timestamp. Any failure publishes a
  `merge-train-promotion-postcondition` failure check **on the actual landed
  commit** and throws; no PR is marked landed on a proof failure.
- **DEC-005**: Immediately before each merge, assert `main` still equals the
  expected base for that entry (**base-CAS**), because the merge API has no
  expected-base parameter. This shrinks the base-movement window to milliseconds;
  the post-merge parent/tree proof (DEC-004) catches any residual race and fails
  closed.
- **DEC-006**: **Fence competing writers.** Disable any armed legacy
  auto-merge (`disablePullRequestAutoMerge`) on admission, and fail closed if a
  train entry has `auto_merge` armed at either reattestation. This closes the
  out-of-order race demonstrated by #1131 (a real merge followed 2s later by a
  train force-push).
- **DEC-007**: **Durable PR↔commit mapping** is the `Merge-Train-PR: <n>`
  trailer written into every squash commit message (identical to the local
  candidate commit trailer). Downstream resolution is **trailer-first**, falling
  back to GitHub commit-to-PR inference only when the trailer is absent
  (`resolve-landed-pr.mjs`, consumed by `deploy.yml` and `manual-preview.yml`).
- **DEC-008**: **Idempotent recovery.** Because promotion now produces real
  merged-state, GitHub's own merged-state is the durable transaction journal.
  A partial promotion (some entries landed, one failed) is legitimate: landed
  PRs are genuinely merged and drop out of the next open-queue scan; the rest
  rebuild from the new `main`. A startup reconciliation
  (`reconcileLandedSignals`) backfills the landed label/comment for any PR that
  was really merged but whose signal update did not complete (crash-after-merge).
  A closed-but-**unmerged** PR is never relabeled landed.
- **DEC-009**: Do **not** post a `merge-train` (required-context) check on a
  landed `main` commit. Under real squash merges the landed commit earns
  ordinary push-CI, which `mainHealthReason` treats as authoritative; a
  `merge-train` check on it would masquerade as the fast-path attestation. The
  post-merge failure check uses the distinct name
  `merge-train-promotion-postcondition`. `merge-train-candidate` remains the
  candidate-validation signal.
- **DEC-010**: Historical force-pushed PRs (e.g. #1149) are backfilled with the
  `merge-train-landed` label and a **truthful** comment (their commit landed;
  their GitHub state remains `closed`/`merged:false` because they predate this
  fix). Their GitHub merged-state is **never** falsified. Scoped so recovery
  (DEC-008) never reclassifies them.

## Consequences

### Positive

- **POS-001**: Every future landed train PR ends GitHub `state = MERGED` with a
  real, non-null `mergeCommit` — the hard requirement.
- **POS-002**: `main` stays squash-linear (each landed commit is a single-parent
  child, proven by DEC-004c).
- **POS-003**: Downstream released/baseline/preview comments target the correct
  original PR via the durable trailer, independent of GitHub inference.
- **POS-004**: PR branches are no longer force-rewritten on promotion, so inline
  review anchors survive (fixes ADR 0060 NEG-001).
- **POS-005**: Partial promotion is naturally, idempotently recoverable via
  real merged-state; no PR is ever silently closed-without-merge.

### Negative

- **NEG-001** (accepted tradeoff, flagged for human sign-off): sequential merges
  transiently expose intermediate `main` states `T_1 … T_{N-1}` (base + prefix)
  that were not **independently** `verify:fast`-validated — only the full
  candidate and any bisected prefixes were. Each intermediate is base+greenPrefix
  and each PR carried a green `ci`, and every merge happens within a single
  reconcile job seconds apart, so the exposure is brief and the **persistent**
  end state (`T_N`) equals the validated candidate tree and is self-healing via
  ordinary push-CI. This weakens ADR 0060 POS-001's "every shipped SHA is the
  exact validated SHA" to "every **persistent** shipped tree is the validated
  tree; transient intermediates are base+green-prefix." Eliminating the
  transient exposure entirely would require validating every prefix or reducing
  to one-PR-per-cycle (see Alternatives).
- **NEG-002**: Lower theoretical throughput ceiling than the single atomic push,
  since each PR is a separate merge API round-trip plus a bounded mergeability
  poll. In practice the batch still validates once; only the landing is
  sequential.

### Risks

- **RSK-001**: The App bypass must cover `PUT .../merge` for a PR that is
  "behind" `main` (every entry after the first) under the strict ruleset. #1131
  is one live datapoint; a disposable **two-PR sequential-merge canary** under
  the live ruleset is required before re-enabling the train (see operational
  guide) to confirm PR 2+ merges.
- **RSK-002**: A local-git vs GitHub server squash could, in principle, produce
  a different tree (custom merge drivers, `.gitattributes` renormalization,
  rename detection). Today's repo has none of those and only LF normalization,
  so the risk is low; DEC-004d fails closed if it ever occurs.

## Alternatives Considered

### One real squash-merge per reconciliation cycle (FIFO)

- **ALT-001**: **Description**: Rebuild/validate only `main + next PR`, merge it
  via the REST API, wait for the post-merge `main` CI, then start a new cycle.
- **ALT-002**: **Rejection reason**: Fully eliminates unvalidated intermediate
  states (NEG-001) and is the simplest recovery model, but it reverses ADR 0060's
  approved speculative-batch throughput optimization (ADR 0060 ALT-003/004) and
  meaningfully lowers throughput. Retained as the fallback if NEG-001's
  transient exposure proves unacceptable in practice.

### Atomic force-push, then "flip" semantics via the merge API

- **ALT-003**: **Description**: Keep the atomic force-push for the tree, then
  additionally call the merge API to record merged-state.
- **ALT-004**: **Rejection reason**: Once the force-push updates a PR's head ref
  to `main`'s tip, GitHub auto-closes the PR with no remaining diff; a closed PR
  cannot then be merged, and GitHub will not retroactively synthesize a merge
  event. Mutually exclusive with real merged-state.

### Git ancestry/tree attestation only; treat PR fields as UI

- **ALT-005**: **Description**: Keep force-push; assert ref/ancestry; treat
  `merged`/`state` as cosmetic.
- **ALT-006**: **Rejection reason**: Directly violates the hard gate. This is the
  retired model (ADR 0062 DEC-025).

### Native GitHub merge queue

- **ALT-007**: **Rejection reason**: Unavailable to this repository (ADR 0060
  ALT-001/002); must not be suggested.
