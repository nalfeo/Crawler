# Repository-Managed Merge Train

Crawler uses a two-candidate speculative merge train when GitHub's native merge
queue is unavailable. The train optimizes merge latency while enforcing one
invariant:

> `main` advances only to the exact candidate SHA that passed merge-train
> validation with its current `main` parent.

See
[`0060-repository-managed-speculative-merge-train.md`](../knowledge/adr/0060-repository-managed-speculative-merge-train.md)
for the architectural rationale.

## How it works

1. CI recovery adds `merge-train` after the PR's admission checks pass and all
   review threads resolve.
2. `.github/workflows/merge-train.yml` serializes reconciliation with
   `queue: max`, selects the two oldest admitted PRs, and creates immutable
   cumulative branches:
   - slot 1: `main+A`
   - slot 2: `main+A+B`
3. `.github/workflows/merge-train-validate.yml` validates each immutable SHA.
   Candidate-executing jobs have read-only permissions. The final publisher job
   does not check out candidate code and writes the `merge-train` check.
4. A green slot 1 is revalidated for current head, title, checks, review threads,
   and `main` parent. The App then:
   - updates the PR head to the tested candidate using an exact force lease;
   - fast-forwards `main` to the same SHA.
5. Slot 2's SHA remains valid after slot 1 lands because it is already a direct
   child of slot 1. It can become the next head without another validation run.

The sticky `<!-- crawler-merge-train:v1 -->` PR comment shows queue position,
candidate SHA, and state.

## Trust boundary

- Only trusted default-branch orchestration receives the repository App token.
- Candidate jobs receive `contents: read` and cannot update refs or checks.
- The check publisher receives `checks: write` but never checks out or executes
  candidate code.
- Fork PRs are ineligible.
- Candidate branches are immutable and named by their complete queue
  fingerprint.
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
   The default is `ci,commit-lint,Security checks`.

Without the App bypass, promotion fails closed after candidate validation.

## Rollout

The train defaults to `off`.

1. Merge the implementation while `MERGE_TRAIN_MODE` is unset.
2. Set shadow mode:

   ```bash
   gh variable set MERGE_TRAIN_MODE --repo nalfeo/Crawler --body dry-run
   ```

3. Manually label two disposable, same-repository PRs `merge-train`. Confirm the
   oldest-first plan and candidate fingerprints in workflow output. Dry-run
   performs no GitHub mutation.
4. Return to `off`, configure the required check and App bypass, then set:

   ```bash
   gh variable set MERGE_TRAIN_MODE --repo nalfeo/Crawler --body live
   ```

5. Run a disposable-PR matrix:
   - two clean PRs validate cumulatively and merge in order;
   - editing a title or pushing a head invalidates the old candidate;
   - a cumulative conflict marks the second PR `merge-train-blocked`;
   - a failed candidate remains queued and never advances `main`;
   - a `main` race rejects promotion and rebuilds;
   - a failure between PR-head update and main update retries the same tested SHA.
6. Confirm GitHub records both disposable PRs as merged and that the merge commit
   OIDs equal their successful `merge-train` check OIDs.

To stop all mutation:

```bash
gh variable set MERGE_TRAIN_MODE --repo nalfeo/Crawler --body off
```

## Failure handling

- **Waiting:** admission checks or review threads are incomplete. CI recovery
  remains responsible for repair.
- **Blocked:** cumulative squash conflicts. The PR receives
  `merge-train-blocked`; repair its source branch, rerun normal CI, and let the
  fingerprint rebuild.
- **Failed:** inspect the candidate's `Merge Train Validation` run. No ref moves.
- **Stale:** a PR head/title or `main` changed. The candidate is abandoned and a
  new immutable generation is built.
- **Promotion denied:** verify App bypass and contents-write permissions. Never
  merge the PR through the ordinary squash path to work around this failure.
