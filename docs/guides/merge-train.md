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
   the PR head's admission checks pass and all review threads resolve.
   Once labeled, CI recovery and broad auto-rebase both leave the PR unchanged;
   the train exclusively owns freshness and promotion.
2. `.github/workflows/merge-train.yml` serializes reconciliation with
   `queue: max`, selects up to six oldest admitted PRs, and creates one combined
   immutable candidate.
3. `.github/workflows/merge-train-validate.yml` runs `verify:fast` plus the
   targeted security suite on that SHA.
   Candidate-executing jobs have read-only permissions. The final publisher job
   does not check out candidate code and writes the
   `merge-train-candidate` result.
4. A green batch is revalidated for current heads, titles, admission
   fingerprints, and `main` parent. Only then does the trusted App publish the
   required `merge-train` check and atomically:
   - updates every PR head to the final validated combined-candidate SHA using
     exact force leases;
   - fast-forwards `main` directly to the validated combined-candidate SHA.
5. If the combined fast gate fails, the train binary-searches ordered prefixes,
   promotes the longest validated green prefix in one atomic update, and returns
   the first failing addition after it to recovery. Later ready PRs remain queued.
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
- Candidate branches are immutable and named by their complete queue
  fingerprint. Reconciliation always reconstructs their expected SHA from
  trusted queue metadata and overwrites the ref; a pre-existing ref is never
  trusted.
- Every promotion re-reads the PR and `main`; stale state fails closed.

## Required repository configuration

Before live mode:

1. Configure branch protection for `main` to require the `merge-train` check.
   Keep existing PR checks required during rollout.
2. Permit only the repository App identified by `APP_ID` to bypass protection
   for the exact fast-forward update. Do not grant broad user bypass.
3. Confirm the App has contents, actions, checks, issues, and pull-request write
   permissions.
4. Keep force-pushes to `main` disabled. Promotion is a fast-forward.
5. Ensure `MERGE_TRAIN_ADMISSION_CHECKS` names the current PR admission checks.
   The default is `ci,Security checks`.

Without the App bypass, promotion fails closed after candidate validation.

## Rollout

One strict boolean controls the complete behavior. There is no partial or
dry-run train mode.

1. Merge the implementation while `MERGE_TRAIN_ENABLED=false`.
2. Configure the required check and App bypass, then set:

   ```bash
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body true
   ```

3. Run a disposable-PR matrix:
   - six clean PRs validate together and merge in order;
   - editing a title or pushing a head invalidates the old candidate;
   - a cumulative conflict returns only that PR to recovery;
   - a failed candidate is bisected and the maximal green prefix advances;
   - a `main` race rejects promotion and rebuilds;
   - a failure between PR-head update and main update retries the same tested SHA.
4. Confirm GitHub records every disposable PR as merged and that the merge commit
   OIDs equal their successful `merge-train` check OIDs.
   Promotion also checks this postcondition in production and fails the train
   run if GitHub does not record every included PR as merged.

To return to the legacy independent-auto-merge and blanket-rebase behavior:

1. Remove `merge-train` from `main`'s required status checks first (or in the
   same change as step 2). Flipping the flag alone does not touch branch
   protection: if `merge-train` is still required, no legacy PR can ever merge
   after rollback, because nothing publishes that check once the train stops
   running.

   ```bash
   gh api repos/nalfeo/Crawler/branches/main/protection/required_status_checks/contexts \
     --method DELETE -f 'contexts[]=merge-train'
   # If main is protected by a ruleset instead of classic branch protection,
   # edit the ruleset's required-status-checks list to drop merge-train
   # instead (`gh api repos/nalfeo/Crawler/rulesets` to find it).
   ```

   Confirm it is gone before proceeding:

   ```bash
   gh api repos/nalfeo/Crawler/branches/main/protection/required_status_checks --jq '.contexts'
   ```

2. Disable the train:

   ```bash
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body false
   ```

With `MERGE_TRAIN_ENABLED=false`, CI recovery's `merge-train`-owned skip
(`ci-recovery/reconcile.mjs`) stops applying, so CI recovery and broad
auto-rebase automatically resume owning freshness and promotion for every PR
still carrying a `merge-train*` label -- no separate step restores that part.
The next recovery sweep removes the train-owned labels (`merge-train`,
`merge-train-blocked`, `merge-train-noop`, `merge-train-validation-failed`)
before returning each PR fully to legacy automation. Step 1 is the only manual
action rollback still requires; steps 2 onward are already automatic once the
flag flips.

## Failure handling

- **Waiting:** admission checks or review threads are incomplete. CI recovery
  remains responsible for repair.
- **Blocked:** cumulative squash conflicts. The PR leaves the active queue and
  receives `merge-train-blocked`; recovery rebases it only after the conflict is
  present on `main`.
- **Failed:** the train bisects prefixes, promotes the largest green prefix, and
  returns the first failing addition with `merge-train-validation-failed`.
- **Stale:** a PR head/title or `main` changed. The candidate is abandoned and a
  new immutable generation is built.
- **Promotion denied:** verify App bypass and contents-write permissions. Never
  merge the PR through the ordinary squash path to work around this failure.
