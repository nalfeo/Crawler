# Handoff: CI Recovery — stale-marker SHA prefix-match auto-resolution

**Date:** 2026-07-25  
**Session slug:** ci-recovery-stale-marker-prefix-fix  
**Apple estimate:** 2🍎 (tooling-only, capped at 3🍎)  
**Branch:** copilot/fix-ci-recovery-loop-2010  
**PR:** closes #2054  
**Systems touched:** ci-recovery

---

## Summary

Investigated the PR #2010 CI recovery loop incident (issue #2054). The automated recovery pipeline made no progress after 2 attempts. Implemented a targeted fix in `reconcile.mjs` that auto-resolves review threads whose stale-marker SHA is a 7-char-prefix typo of the current PR head.

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

After the lineage-check loop (which populates `definitivelyUnreachableMarkerShas`), added a promotion step that scans for SHAs whose first 7 characters are a valid abbreviated prefix of the current head SHA:

```javascript
for (const sha of [...definitivelyUnreachableMarkerShas]) {
  if (sha.length >= 7 && headSha.startsWith(sha.slice(0, 7)) && !headSha.startsWith(sha)) {
    reachableMarkerShas.add(sha);
    definitivelyUnreachableMarkerShas.delete(sha);
    process.stdout.write(
      `promoted stale-marker sha=${sha} to reachable via 7-char prefix match head=${headSha}\n`,
    );
  }
}
```

**Why this is safe:**
- A 40-char SHA returning 404 (doesn't exist as a commit) whose first 7 chars match the head is strong evidence of a transcription error, not an absent fix.
- The 7-char prefix is the same length used by the existing abbreviated-SHA acceptance logic (`headSha.startsWith(markerSha)` for short SHAs), so the additional attack surface is no greater than the existing path.
- The reconciler still requires a trusted author (`TRUSTED_BOT_LOGINS` or `TRUSTED_ASSOCIATIONS`) for the marker to be in the stale-marker candidate set in the first place.

**What this does NOT fix:**
- PR #2010's merge conflict and format failures — those require the PR author to rebase and fix formatting.
- Model unavailability (claude-sonnet-4.5) — separate infrastructure concern.

---

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — added prefix-match promotion step (~22 lines + Prettier reformatting of surrounding code)
- `.github/scripts/ci-recovery/reconcile.test.mjs` — added regression test: `stale-marker SHA that is a typo of head SHA (same 7-char prefix, 404) is auto-resolved`
- `docs/knowledge/review-ledgers/2026-07-25-ci-recovery-stale-marker-prefix-fix.review-ledger.json` — 2🍎 ledger

---

## Verification run

- All 137 reconcile.test.mjs tests pass (up from 136 before this PR)
- New test: `stale-marker SHA that is a typo of head SHA (same 7-char prefix, 404) is auto-resolved` — PASS
- Existing tests unchanged: `non-outdated stale-marker thread includes recovery hint in blocker summary` — PASS, `outdated stale-marker thread stays on the stale-marker hint path` — PASS
- Prettier format check passes on both changed files
- `verify:pr-prereqs` passes after adding handoff + ledger

---

## Unresolved issues

- PR #2010 still has merge conflicts and a format failure — it needs manual rebase + format fix by the author.
- The `stallAttempt >= 2` threshold with model-unavailability failures could still cause false loop-incident escalations for other PRs when the model is down. A future improvement could distinguish model-unavailability failures from genuine fix-attempt failures before counting them toward the threshold.

---

## Recommended next steps

- Monitor that PR #2010's thread `PRRT_kwDOSvo2Ms6Tv5hP` is auto-resolved on the next reconciler run (the fix is live after this PR merges).
- Consider adding a model-unavailability exemption to the `stallAttempt` counter to prevent false escalations during model outages.
