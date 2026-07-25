# CI Recovery Loop Investigation — PR #1886

**Date:** 2026-07-25  
**Session slug:** `ci-recovery-loop-pr-1886`  
**Apple estimate:** 1🍎 (investigation-only, no code defect found)  
**Closes:** #2033  
**Affects:** PR #1886 (`feat: retire foundry backend, standardize asset pipeline on azure-openai`)

## Systems touched

ci-recovery

## Summary

Investigated why the CI recovery automation failed to converge on PR #1886 after 2 dispatch
attempts. Determined root cause, confirmed no deterministic code defect exists in the
marker parser, permission grant, thread-resolution path, or mutation sequence, and posted
the missing `✅ Addressed` markers to the 3 unresolved review threads that were blocking
the PR.

## Root Cause

### 1. Transient infrastructure failure — model unavailable

Both recovery attempts failed immediately with:

```
[cca-engine] Error: Error: Request session.create failed with message:
Model "claude-sonnet-4.5" is not available.
```

The Copilot SWE agent (`claude-sonnet-4.5`) was unavailable on 2026-07-25 for an extended
period. Every CCA job dispatched to fix the PR failed at startup before doing any work.

### 2. Consequence — missing addressed markers

The recovery automation's job is:
1. Dispatch the Copilot SWE agent with a task listing all blockers.
2. Copilot fixes code, pushes a repair commit, and posts `✅ Addressed in <sha>: <reason>`
   replies to each blocked review thread.
3. The reconciler resolves threads whose last trusted comment carries a valid marker.

Because Copilot could not start, step 2 never happened. After 2 failed dispatches, the
automation correctly filed the loop incident (issue #2033) and released ownership.

A developer subsequently pushed commit `a806d4b76eac6855c39538e1c381a4b23dd12688` to fix
the underlying code issues, and manually posted a marker on 1 of the 4 review threads
(`PRRT_kwDOSvo2Ms6Tevh7` — now resolved). The remaining 3 threads lacked markers and
remained unresolved.

## Defect Analysis

| Component | Finding |
|-----------|---------|
| **Marker parser** (`extractAddressedMarkerSha`) | ✓ Correct. Strips trailing colons/punctuation (`[):.,;!?]+$`), handles SHA URLs, slash-separated SHA pairs. |
| **Thread-resolution path** (`shouldResolveThread`) | ✓ Correct. Requires last comment to be from trusted author (OWNER/MEMBER/COLLABORATOR or known bot) carrying a valid marker. |
| **Permission grant** | ✓ Correct. Recovery uses `CRAWLER_CI_PAT` for GraphQL `resolveReviewThread` mutation. |
| **Mutation sequence** | ✓ Correct. Posts task comment → assigns Copilot → tracks ownership via state comment → files loop incident after 2 exhausted attempts. |

**No deterministic code defect was found.** The failure was entirely due to external
infrastructure (model unavailability).

## Fix Applied

Posted `✅ Addressed in a806d4b76eac6855c39538e1c381a4b23dd12688` markers to the 3
unresolved review threads in PR #1886:

| Thread | File | Comment ID | Reason |
|--------|------|------------|--------|
| `PRRT_kwDOSvo2Ms6TeviL` | `scripts/setup-azure-env.ps1` | 3643726829 | Removed all `$IncludeFoundry`/`$FoundryResourceGroup`/`$FoundryLocation`/`$FoundryAccountName` refs and removed `-IncludeFoundry` from package scripts |
| `PRRT_kwDOSvo2Ms6TeviX` | `.github/workflows/asset-request.yml` | 3643726851 | Updated contract test to assert `AZURE_OPENAI_*` keys and no `FOUNDRY_*` keys |
| `PRRT_kwDOSvo2Ms6Teviw` | `scripts/sprites/sidecar/env-bootstrap.ts` | 3643726884 | Replaced `foundry` cases with `local-a1111` in `imageProviderIsAzureOpenAi` and `needsAzureEnvBootstrap` tests |

With these markers in place, the CI recovery reconciler can auto-resolve the threads on its
next run using the `resolveReviewThread` GraphQL mutation. The remaining blocker
(`ci-failure: copilot`) will clear once the model becomes available and a new Copilot job
can complete successfully.

## What the Recovery Got Right

The loop incident filing (issue #2033) was the correct and expected behavior:
- The recovery retried exactly the configured maximum (2 attempts).
- It filed a deduplicated incident (`blockerFingerprint`) so the same exhausted state
  doesn't spawn multiple identical issues.
- The head SHA was recorded in the incident so future reconcilers know when the state
  belongs to an older head.

## Known Remaining State

After this session:
- Threads `PRRT_kwDOSvo2Ms6TeviL`, `PRRT_kwDOSvo2Ms6TeviX`, `PRRT_kwDOSvo2Ms6Teviw`:
  markers posted → resolvable on next reconcile run.
- `ci-failure: copilot` check run: still present; will clear when the model becomes
  available and a new Copilot dispatch succeeds.
- The recovery state comment on PR #1886 is in `owner: 'none', status: 'idle',
  trigger: 'stale-automation-exhausted'` for the old blocker fingerprint. When the
  reconciler runs again with the new (thread-free) fingerprint, `automationStallAction`
  will return `'new'` (owner is `'none'`), resetting the attempt counter.

## Regression Test Recommendation

No new test is needed: the existing `state.test.mjs` and `reconcile.test.mjs` suites
already cover `shouldResolveThread`, `extractAddressedMarkerSha`, `isDuplicateDispatch`,
and `automationStallAction` in detail. The failure mode here is purely operational
(external model unavailability), not a logic defect in the recovery scripts.
