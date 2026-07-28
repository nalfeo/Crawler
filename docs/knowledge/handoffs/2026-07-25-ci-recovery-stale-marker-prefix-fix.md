# Handoff: CI Recovery — stale-marker SHA prefix-match auto-resolution

**Date:** 2026-07-25  
**Session slug:** ci-recovery-stale-marker-prefix-fix  
**Apple estimate:** 2🍎 (tooling-only, capped at 3🍎)  
**Branch:** copilot/fix-ci-recovery-loop-2010  
**PR:** closes #2054  
**Systems touched:** ci-policy

---

## Summary

Investigated the PR #2010 CI recovery loop incident (issue #2054). The automated recovery pipeline made no progress after 2 attempts. Implemented a targeted fix in `reconcile.mjs` that auto-resolves review threads only when the stale-marker SHA is a **404-missing, full 40-char, one-digit typo** of the current PR head.

---

## Root causes of the PR #2010 loop incident

### 1. One-digit SHA typo in the `✅ Addressed in` marker

The recovery agent posted `✅ Addressed in e6380eb20825a047d75c65e62f11f3fe**20**afef77:` on thread `PRRT_kwDOSvo2Ms6Tv5hP`, but the actual PR head SHA was `e6380eb20825a047d75c65e62f11f3fe**19**afef77` (digits `20` vs `19` at position 32). The compare API returned 404, correctly placing the typo SHA in `definitivelyUnreachableMarkerShas`. The stale-marker hint path then required an LLM agent to re-post with the correct SHA.

### 2. LLM model unavailable (claude-sonnet-4.5)

Both repair attempts failed with `Model "claude-sonnet-4.5" is not available`. Each failure incremented `stallAttempt`, and after 2 failed dispatches the loop-incident was filed (threshold: `stallAttempt >= 2`).

### 3. Merge conflict (side issue, not fixed here)

PR #2010 also has `mergeable_state: "dirty"` which triggered the `RELEASE_STALE_AUTOMATION_CONFLICT` rule. The merge conflict and format failure (`src/engine/MobAbilityVfx.ts` failed Prettier) remain on PR #2010's branch and require the PR author to fix them.

---

## The fix

**File:** `.github/scripts/ci-recovery/reconcile.mjs`

After the lineage-check loop:

- keep successful `behind` / `diverged` compare results in `definitivelyUnreachableMarkerShas` only;
- track 404-missing SHAs separately in `definitivelyMissingMarkerShas`;
- promote only those missing SHAs that still share the head's 7-char abbreviation **and** differ from the head by exactly one hex digit.

```javascript
for (const sha of [...definitivelyMissingMarkerShas]) {
  if (headSha.startsWith(sha.slice(0, 7)) && differsByExactlyOneHexDigit(sha, headSha)) {
    reachableMarkerShas.add(sha);
    definitivelyUnreachableMarkerShas.delete(sha);
    definitivelyMissingMarkerShas.delete(sha);
    process.stdout.write(
      `promoted stale-marker sha=${sha} to reachable via one-digit typo match head=${headSha}\n`,
    );
  }
}
```

**Why this is safe:**

- A real divergent or behind commit can no longer be reclassified as reachable just because its first 7 chars collide with the head.
- A random 404-missing SHA can no longer auto-resolve unless it is a full-length near-match to the head (exactly one differing hex digit), which matches the reported transcription-error incident.
- The reconciler still requires a trusted author (`TRUSTED_BOT_LOGINS` or `TRUSTED_ASSOCIATIONS`) for the marker to be in the stale-marker candidate set in the first place.

**What this does NOT fix:**

- PR #2010's merge conflict and format failures — those require the PR author to rebase and fix formatting.
- Model unavailability (claude-sonnet-4.5) — separate infrastructure concern.

---

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — narrowed stale-marker typo promotion to 404-missing, one-digit near-matches and kept divergent/behind commits stale
- `.github/scripts/ci-recovery/reconcile.test.mjs` — added a faithful positive typo regression plus negative regressions for divergent-prefix and non-near-match 404 cases
- `docs/knowledge/review-ledgers/2026-07-25-ci-recovery-stale-marker-prefix-fix.review-ledger.json` — 2🍎 ledger

---

## Verification run

- All 139 reconcile.test.mjs tests pass (up from 136 before this PR)
- New positive test: `stale-marker SHA that is a one-digit typo of head SHA (404) is auto-resolved` — PASS
- New negative tests:
  - `diverged/behind stale-marker SHA that shares head prefix is not auto-resolved` — PASS
  - `missing stale-marker SHA with same 7-char prefix but many differing digits is not auto-resolved` — PASS
- `verify:pr-prereqs` passes
- `verify:fast` could not complete in this sandbox because dependency installation never finished; `npx` fell back to ad-hoc `tsc` / `eslint` packages instead of the repo toolchain

---

## Unresolved issues

- PR #2010 still has merge conflicts and a format failure — it needs manual rebase + format fix by the author.
- The `stallAttempt >= 2` threshold with model-unavailability failures could still cause false loop-incident escalations for other PRs when the model is down. A future improvement could distinguish model-unavailability failures from genuine fix-attempt failures before counting them toward the threshold.

---

## Recommended next steps

- Monitor that PR #2010's thread `PRRT_kwDOSvo2Ms6Tv5hP` is auto-resolved on the next reconciler run (the fix is live after this PR merges).
- Consider adding a model-unavailability exemption to the `stallAttempt` counter to prevent false escalations during model outages.
