# Repository-Managed Merge Train

Crawler uses a repository-managed build-expiry merge train because GitHub's
native merge queue is unavailable to this repository. The train optimizes
throughput while enforcing one
invariant:

> `main` advances only to the exact candidate SHA that passed merge-train
> validation with its current `main` parent.

See
[`0060-repository-managed-speculative-merge-train.md`](../knowledge/adr/0060-repository-managed-speculative-merge-train.md)
for the architectural rationale.

## How it works

1. CI recovery works the six oldest non-ready PRs and adds `merge-train` after
   the PR head's admission checks pass, all review threads resolve, and the PR
   has at least one substantive Copilot code review in its history. Blank and
   explicit no-files review responses do not count. This admission proof is not
   tied to the current head; significant-change re-review policy is enforced
   separately to avoid review churn for trivial updates.
   Once labeled, CI recovery and broad auto-rebase both leave the PR unchanged;
   the train exclusively owns freshness and promotion.
2. `.github/workflows/merge-train.yml` serializes the gated `reconcile` job with
   `queue: single` (one active job plus only the latest pending admitted wake),
   selects up to six oldest admitted PRs, and creates one combined immutable
   candidate. Job-level placement keeps rejected PR events out of the queue, so a
   no-op wake cannot displace meaningful pending work.
3. `.github/workflows/merge-train-validate.yml` runs every `verify:fast` gate
   plus the targeted security suite on that SHA as parallel read-only jobs.
   Complete unit and sprite projects use deterministic Vitest shards; no
   affected-only filtering is used.
   Candidate-executing jobs have read-only permissions. The final publisher job
   does not check out candidate code and writes the
   `merge-train-candidate` result.
4. A green batch is revalidated for current heads, titles, admission
   fingerprints, and `main` parent. Only then does the trusted App promote it by
   **sequential GitHub squash-merges** — one `PUT /pulls/{n}/merge`
   (`merge_method: squash`) per PR, in candidate order — so GitHub records each
   PR as genuinely `merged` with a real merge commit. Before any label/comment,
   each landed commit is proven to be recorded merged, be a single-parent child
   of the expected base (linear `main`), and carry the exact tree of the
   validated candidate prefix, or the run fails closed (see
   [`0063-merge-train-real-squash-merge-promotion.md`](../knowledge/adr/0063-merge-train-real-squash-merge-promotion.md)).
   Reconciliation resumes a landed signal only after the durable
   `merge-train-landed` proof-complete marker exists; a crash after proof but
   before that marker never fabricates a landed signal. Closed PRs always lose
   the transient `merge-train` queue label. If landed-proof APIs are temporarily
   unavailable, reconciliation first adds `merge-train-recovery-pending`, clears
   `merge-train`, and retries from that dedicated marker on a later run.
5. The maximal cumulative prefix is validated first. A successful maximal
   candidate authorizes the FIFO batch in one validation round. Only a genuine
   terminal candidate failure requests smaller prefixes through bisection; a
   cancelled, stale, or infrastructure result retries the same maximal candidate.
   Once bisection isolates the first failing addition, the train promotes the
   validated green prefix and returns that addition to recovery. Later ready PRs
   remain queued.
6. A textual conflict removes only that PR from readiness. Recovery performs a
   conflict-only rebase onto the resulting `main`; the new head reruns heavy PR
   validation.

The sticky `<!-- crawler-merge-train:v1 -->` PR comment shows queue position,
candidate SHA, and state.

## Trust boundary

- Only trusted default-branch orchestration receives the repository App token.
- Candidate jobs receive `contents: read` and cannot update refs or checks.
- The check publisher receives `checks: write` but never checks out or executes
  candidate code. It publishes only `merge-train-candidate`; the required
  `merge-train` context is written by trusted reconciliation immediately before
  promotion.
- Fork PRs are ineligible.
- Candidate refs are immutable, named by their complete queue fingerprint, and
  stored under `refs/merge-train-candidates/**`. Each ref points to an opaque Git
  blob containing a thin bundle of the exact candidate commit, not to the commit
  itself. GitHub therefore never evaluates the bundled `.github/workflows/**`
  paths during ref mutation. The refs are also outside `refs/heads/**` and
  `refs/tags/**`, so creating or updating one cannot emit a branch/tag `push` or
  `create` event that executes unvalidated candidate workflow files.
- Read-only validation fetches the blob ref, verifies its object type, verifies
  and imports the bundle, and rejects any materialized commit whose SHA differs
  from the trusted dispatch input. Fingerprinted check evidence is attached to
  the trusted `main` commit because the candidate commit remains outside GitHub's
  repository object graph. Its external ID binds both the complete queue
  fingerprint and exact candidate SHA, so a manual validation dispatch cannot
  substitute a different passing bundle. Reconciliation reconstructs the full
  candidate locally before every decision and never trusts a pre-existing
  transport ref.
- All candidate refs use the repository App credential persisted by the trusted
  checkout. No PAT or `GITHUB_TOKEN` credential override is used for candidate
  transport. Validation remains an explicit trusted dispatch bound to the
  immutable candidate SHA.
- Every promotion re-reads the PR and `main`; stale state fails closed.

## Required repository configuration

Before live mode:

1. **Run `enable` only after the `protection.mjs` tooling's own PR has merged
   to `main` -- never before, and never as part of that same PR's merge.**
   Once the ruleset is active, every non-bypass actor (including an ordinary
   `gh pr merge`) must satisfy both `ci` and `merge-train`; nothing posts a
   `merge-train` check for an ordinary PR. Running `enable` before the
   tooling PR merges would self-block that PR's own merge -- and every other
   in-flight ordinary PR -- behind a check that can never be satisfied.
2. Run the idempotent protection tool to move live required-status enforcement
   for `refs/heads/main` from classic branch protection to a dedicated
   repository ruleset:

   ```bash
   node .github/scripts/merge-train/protection.mjs enable --app-id <APP_ID>
   ```

   This creates/updates the **"Merge Train Required Checks"** ruleset, which:
   - requires `ci` (the built-in GitHub Actions App) **and** `merge-train` for
     every actor except one;
   - grants exactly one bypass actor `bypass_mode: always`: the repository App
     identified by `APP_ID` (`actor_type: 'Integration'`) -- the only identity
     that may perform the internally reattested sequential squash-merge
     promotion (the App bypass is what lets it merge a PR that is "behind"
     `main` and lacks the `merge-train` check);
   - leaves classic branch protection's `required_conversation_resolution`,
     `allow_force_pushes`, `allow_deletions`, and every other classic setting
     untouched.

   It also disables (does not delete) classic protection's
   `required_status_checks`, because classic protection has **no mechanism** to
   grant a per-App bypass for a required context -- only rulesets support
   `bypass_actors`. Leaving classic `required_status_checks` live alongside the
   ruleset would let it independently block the App's promotion push even once
   the ruleset is correctly configured. See
   [`0062-merge-train-ruleset-app-bypass.md`](../knowledge/adr/0062-merge-train-ruleset-app-bypass.md)
   for the full rationale, including why this failed with `GH006` under the
   original classic-protection design (ADR 0060 DEC-009).

3. Confirm the App has contents, actions, checks, issues, and pull-request write
   permissions, **plus repository Administration write access** (required to
   create/update rulesets via `POST`/`PUT .../rulesets` -- without it, `enable`
   fails with `403` even though every other prerequisite in this checklist is
   satisfied).
4. Keep candidate transport as bundle blobs under
   `refs/merge-train-candidates/**`; never point those refs at candidate commits
   or move them into `refs/heads/**` or `refs/tags/**`. The trusted repository App
   needs Contents write access for blob-ref transport, while the workflow's
   built-in `GITHUB_TOKEN` remains `contents: read` and is used to fetch the
   opaque blob and dispatch trusted validation, not to push candidate commits.
5. Keep force-pushes to `main` disabled (unchanged, still enforced by classic
   protection). Promotion no longer pushes `main` directly at all -- it uses
   GitHub's own squash-merge API, one PR at a time.
6. Ensure `MERGE_TRAIN_ADMISSION_CHECKS` names the current PR admission checks.
   The default is `ci,Security checks`.
7. Verify the postcondition before enabling the train:

   ```bash
   node .github/scripts/merge-train/protection.mjs status --app-id <APP_ID>
   ```

   Confirm `classic.requiredStatusChecksDisabled: true` and
   `ruleset.problems: []`.

Without the ruleset's App bypass live and classic `required_status_checks`
disabled, promotion fails closed after candidate validation (`GH006`).

## Rollout

One strict boolean controls the complete behavior. There is no partial or
dry-run train mode.

1. Merge the implementation while `MERGE_TRAIN_ENABLED=false`.
2. Configure the ruleset and App bypass (see
   [Required repository configuration](#required-repository-configuration)
   above), confirm `protection.mjs status` reports a clean postcondition, then
   set:

   ```bash
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body true
   ```

3. Run a disposable-PR matrix:
   - six clean PRs validate together and merge in order;
   - editing a title or pushing a head invalidates the old candidate;
   - a cumulative conflict returns only that PR to recovery;
   - a failed maximal candidate is bisected and the validated green prefix advances;
   - a `main` race rejects promotion and rebuilds;
   - a failure between PR-head update and main update retries the same tested SHA.
4. Confirm GitHub records **every** disposable PR as `merged` (real `merged_at`
   plus a non-null merge commit), that `main` stays linear, and that each landed
   commit's tree matches the validated candidate. Promotion enforces this
   postcondition in production (`landedCommitProofError`) and fails the run
   closed on any mismatch, publishing a `merge-train-promotion-postcondition`
   failure check on the actual landed commit.

   > **Promotion uses GitHub's own squash-merge machinery, so completion is
   > proven by real `merged: true` — never by `state: closed` alone.** The train
   > merges each admitted PR in candidate order via
   > `PUT /repos/{owner}/{repo}/pulls/{n}/merge` (`merge_method: squash`); the
   > trusted App's ruleset bypass lets it merge a PR that is "behind" `main` and
   > lacks the `merge-train` check. This replaces the earlier atomic multi-ref
   > force-push, which auto-closed PRs **without ever setting** `merged` /
   > `merged_at` — the forbidden CLOSED-plus-null outcome that stranded seven
   > real promoted PRs (see the superseded ADR 0062 DEC-025 and the ADR 0063
   > context). A non-null `merge_commit_sha` alone is **not** sufficient proof:
   > for a closed-unmerged PR it is an ephemeral test-merge SHA, not the landed
   > commit. Because a server-side squash necessarily creates a new commit SHA,
   > promotion proves the landed commit's **tree** equals the validated candidate
   > prefix (content equivalence) rather than exact-SHA equality — see ADR 0063
   > DEC-002.
   >
   > **Required two-PR canary before enabling for real traffic.** Because every
   > entry after the first is "behind" `main`, run a disposable **two-PR**
   > sequential-merge canary under the live ruleset and confirm the SECOND PR
   > merges — proving the App bypass covers a behind-PR squash under strict
   > required-status enforcement — before flipping `MERGE_TRAIN_ENABLED=true`.

To return to the legacy independent-auto-merge and blanket-rebase behavior:

1. Disable the train first:

   ```bash
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body false
   ```

   This fails closed: while the ruleset still requires `merge-train`, nothing
   publishes it once the train stops running, so every PR is safely _blocked_
   from merging rather than merging without validation. Do not reverse this
   order: rolling back protection before disabling the flag opens a window
   where the train is still enabled but no longer gated, so a PR could merge
   before the train (or anything else) has actually validated it.

2. Once the train is confirmed disabled, restore classic `ci`-only protection
   and disable the ruleset:

   ```bash
   node .github/scripts/merge-train/protection.mjs rollback
   ```

   This restores classic `required_status_checks` to the exact pre-fix legacy
   shape (`ci`, strict, scoped to the GitHub Actions App) **before** disabling
   the ruleset, so there is never a window where neither classic protection
   nor the ruleset enforces `ci` on `main`. It refuses to run (without
   `--force`) while `MERGE_TRAIN_ENABLED=true`, and it disables the ruleset
   rather than deleting it, so it can be re-enabled or audited later. Confirm
   with:

   ```bash
   node .github/scripts/merge-train/protection.mjs status
   ```

   `classic.requiredStatusChecksRestored` must be `true` and
   `ruleset.enforcement` must not be `active`.

With `MERGE_TRAIN_ENABLED=false`, CI recovery's `merge-train`-owned skip
(`ci-recovery/reconcile.mjs`) stops applying, so CI recovery and broad
auto-rebase automatically resume owning freshness and promotion for every PR
still carrying a `merge-train*` label -- no separate step restores that part.
The next recovery sweep removes the train-owned labels (`merge-train`,
`merge-train-blocked`, `merge-train-noop`, `merge-train-validation-failed`)
before returning each PR fully to legacy automation. Step 2 (restoring classic
protection and disabling the ruleset, once the train is confirmed disabled) is
the only manual action rollback still requires; freshness/promotion ownership
resumes automatically.

## Main is red (attribution pause, not a promotion block)

Main's own CI health is **not** a promotion gate (ADR 0077). The validated
composite candidate -- `main` + the FIFO prefix, proven green by the full merge
gate -- is the sole promotion gate. A green composite promotes even when `main`
alone is red, which is precisely how a PR that **fixes** a red `main` lands
through the train instead of deadlocking behind it.

`mainAttributionVerdict()` (`merge-train/reconcile-lib.mjs`) is consulted only
when the **maximal composite fails**, to decide whether that failure is
attributable to a queued PR:

| maximal composite | verdict             | behaviour                                                                                       |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| success           | not consulted       | promote                                                                                         |
| failure           | `green` / `unknown` | bisect, isolate and eject the first failing addition                                            |
| failure           | `red`               | eject nothing; still promote any already-proven green prefix, and skip further bisection rounds |

The pause exists because a red composite has two possible causes -- the PR broke
it, or `main` was already broken -- and the composite result alone cannot tell
them apart. If `main` is red for an unrelated reason, every prefix including
prefix 1 fails, bisection converges on green=0/red=1, and the train would eject
innocent PRs one per round down the whole queue. Pausing preserves that
anti-mass-ejection property without blocking promotion.

`unknown` (no full-CI evidence yet, or still pending) deliberately does **not**
pause: absence of evidence attributes nothing, and after every train promotion
the only run on the new `main` is the excluded fast-path attestation, so
"unknown" is the steady state. Failing closed there would suspend ejection of
genuinely broken PRs until the next daily full-CI backstop.

**Residual, accepted:** if `main` is positively red _and_ the maximal composite
genuinely fails, the train stops isolating -- it ejects nothing and spends no
further bisection rounds until `main` goes green, logging
`paused merge train attribution; ...` in the reconcile log. A prefix already
proven green still promotes, so a queued repair PR is not held back; the cost is
that a genuinely-broken queued PR sits in the queue instead of being ejected. To
clear it, drop the broken PR's `merge-train` label, or fall back to the
disable-the-train lane below.

## Emergency repair lane (train disabled)

If the train itself is malfunctioning -- not merely paused on attribution -- the
documented fallback is the legacy per-PR path:

1. Disable the train:

   ```bash
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body false
   ```

2. Restore classic `ci`-only protection and disable the ruleset (same command
   as the Rollback section above):

   ```bash
   node .github/scripts/merge-train/protection.mjs rollback
   ```

   Confirm it is done before proceeding:

   ```bash
   node .github/scripts/merge-train/protection.mjs status
   ```

3. Confirm legacy freshness ownership resumed. No manual action is needed:
   the next `ci-recovery/reconcile.mjs` sweep sees `MERGE_TRAIN_ENABLED=false`,
   strips the train-owned labels from any in-flight PR (including the repair
   PR once it exists), and CI recovery/auto-rebase resume owning freshness and
   readiness exactly as before this feature existed.
4. If the repair PR is not already open, let `ci-recovery-incidents.yml` /
   `incident.mjs` open it and assign Copilot as usual (this happens
   automatically off any red `main` CI run, push-triggered or from the daily
   backstop, whether or not the train is enabled), or open it directly. Either
   way, once step 1-2 land, the repair PR merges through the **ordinary** legacy
   auto-merge path -- gated by its own required PR checks like every other PR
   before this feature existed. Nothing bypasses the repair PR's own CI.
5. After the repair PR merges, confirm the next **push-triggered** full `CI`
   run on the new `main` SHA is green; do not re-enable the train on the
   strength of the repair PR's own head-check evidence alone, since that
   predates the merge.
6. Only once that push-triggered run is green: re-enable the ruleset and the
   train:

   ```bash
   node .github/scripts/merge-train/protection.mjs enable --app-id <APP_ID>
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body true
   ```

This lane does not add a code path that lets the train promote unvalidated code
-- it takes the repair PR out of the train entirely and merges it through the
same legacy, per-PR-gated path that already exists as the flag-off fallback for
everything else.

## Failure handling

- **Waiting:** admission checks or review threads are incomplete. CI recovery
  remains responsible for repair.
- **Blocked:** cumulative squash conflicts. The PR leaves the active queue and
  receives `merge-train-blocked`; recovery rebases it only after the conflict is
  present on `main`.
- **Failed:** a genuine maximal-candidate failure starts prefix bisection. The
  train promotes the largest validated green prefix, marks the first isolated
  failing addition `merge-train-validation-failed`, and returns it to recovery.
- **Closed with stale queue state:** reconciliation removes `merge-train` from
  every closed PR. A provable interrupted landing receives the truthful landed
  comment before cleanup; an unprovable closure loses only transient queue/retry
  labels. Indeterminate proof reads move to `merge-train-recovery-pending` so a
  later run can retry without presenting the closed PR as queued.
- **Stale:** a PR head/title or `main` changed. The candidate is abandoned and a
  new immutable generation is built.
- **Promotion denied:** run `node .github/scripts/merge-train/protection.mjs
status --app-id <APP_ID>` and verify `classic.requiredStatusChecksDisabled`
  is `true` and `ruleset.problems` is empty. Never merge the PR through the
  ordinary squash path to work around this failure.
- **Candidate custom-ref push denied:** confirm the trusted repository App still
  has Contents write access and the destination starts with
  `refs/merge-train-candidates/`, then confirm the local source ref resolves to a
  Git `blob`. Never fall back to pushing the candidate commit itself or to a branch
  or tag ref: commit transport reintroduces workflow-write permission, and
  branch/tag namespaces can execute unvalidated candidate workflows. A repair
  that changes the transport cannot bootstrap through the deployed controller
  already blocked on the FIFO leader; use only the documented protected emergency
  lane.
- **Attribution pause:** the maximal composite is red _and_ `main` itself is
  positively red, so the failure cannot be attributed to any queued PR. The
  train ejects nobody and spends no bisection round; it resumes automatically
  once `main` has green full-CI evidence. See
  [Main is red](#main-is-red-attribution-pause-not-a-promotion-block) above.
