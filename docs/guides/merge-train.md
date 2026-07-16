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
5. Every cumulative prefix is validated (in parallel) before any merge, so no
   unvalidated intermediate tree is ever exposed on `main`. If a prefix fails,
   the train promotes the maximal fully-validated green prefix and returns the
   first failing addition to recovery. Later ready PRs remain queued.
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
4. Keep force-pushes to `main` disabled (unchanged, still enforced by classic
   protection). Promotion no longer pushes `main` directly at all -- it uses
   GitHub's own squash-merge API, one PR at a time.
5. Ensure `MERGE_TRAIN_ADMISSION_CHECKS` names the current PR admission checks.
   The default is `ci,Security checks`.
6. Verify the postcondition before enabling the train:

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
   - a failed prefix is localized and the maximal validated green prefix advances;
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

## Emergency repair lane (main-health deadlock)

`mainHealthAllowsPromotion()` (`merge-train/reconcile.mjs`) fails closed: it
pauses **every** promotion whenever the latest non-fast-path full-CI run for
the current `main` SHA is missing, pending, or red. This is intentional -- it
stops the train from building on top of a broken `main` -- but it has one
structural consequence worth naming explicitly: the incident workflow that
diagnoses a red hourly `main` run asks Copilot to land the fix through an
ordinary PR, and that PR is itself just another train candidate. While
`main` stays red, the circuit breaker that is supposed to protect the train
also blocks the one promotion that would fix it, and every subsequent hourly
run keeps re-testing the same broken SHA. **The train cannot self-heal a red
`main` from inside the train.**

This is deliberate, not a bug: allowing the train to promote its way out of a
red `main` autonomously would mean designing a bypass that decides, by itself,
when it's safe to build on top of known-broken code -- exactly the kind of
"promote arbitrary code while main is red" hole this guide's trust boundary
exists to prevent. Recovering from this state is instead an explicit,
documented, human-triggered fallback to the legacy path the train is meant to
replace, using machinery this repository already has and already trusts:

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
   `incident.mjs` open it and assign Copilot as usual (this already happens
   automatically off the red hourly run), or open it directly. Either way,
   once step 1-2 land, the repair PR merges through the **ordinary** legacy
   auto-merge path -- gated by its own required PR checks like every other PR
   before this feature existed. Nothing bypasses the repair PR's own CI.
5. After the repair PR merges, confirm the next **push-triggered** full `CI`
   run on the new `main` SHA is green. This is the same authoritative evidence
   `mainHealthAllowsPromotion()` looks for; do not re-enable the train on the
   strength of the repair PR's own head-check evidence alone, since that
   predates the merge.
6. Only once that push-triggered run is green: re-enable the ruleset and the
   train:

   ```bash
   node .github/scripts/merge-train/protection.mjs enable --app-id <APP_ID>
   gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body true
   ```

This lane does not weaken `mainHealthAllowsPromotion()` or add a code path that
lets the train promote onto red evidence -- it takes the repair PR out of the
train entirely and merges it through the same legacy, per-PR-gated path that
already exists as the flag-off fallback for everything else. The train
resumes only once real, current, push-triggered green evidence exists for the
repaired `main`.

## Failure handling

- **Waiting:** admission checks or review threads are incomplete. CI recovery
  remains responsible for repair.
- **Blocked:** cumulative squash conflicts. The PR leaves the active queue and
  receives `merge-train-blocked`; recovery rebases it only after the conflict is
  present on `main`.
- **Failed:** every prefix is validated, so the train localizes the first
  failing PR directly, promotes the largest validated green prefix before it, and
  returns the failing addition with `merge-train-validation-failed`.
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
- **Main-health deadlock:** every hourly full-CI run for the current `main` SHA
  is red (or missing/pending), so `mainHealthAllowsPromotion()` pauses all
  promotion, including the repair PR's own. This is the one case where the
  ordinary legacy merge path is the correct, documented recovery -- see
  [Emergency repair lane](#emergency-repair-lane-main-health-deadlock) above.
