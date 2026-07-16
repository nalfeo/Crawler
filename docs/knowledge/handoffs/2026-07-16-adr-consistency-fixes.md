# Handoff: ADR Consistency Fixes (security-review 2026-07-13 findings)

**Date:** 2026-07-16  
**Session:** adr-consistency-fixes  
**PR:** closes #1117  
**Apple estimate:** 🍎 x 1 — pure documentation fixes, no code changes

## Systems touched

docs

## Summary

Resolved all remaining ADR consistency findings surfaced by the
`docs-check-adr-consistency` script (part of the security-review loop). The
original 2026-07-13 security report flagged 8 warnings + 1 blocking error; by
the time this session ran most were already fixed by earlier PRs. The checker
found a fresh set of 4 issues on 2026-07-16.

## Changes made

### 1. `docs/knowledge/adr/0007-spatial-units-architecture.md`

The "## Related" section referenced
`` `docs/knowledge/handoffs/2026-06-08-px-to-feet.md` `` (backtick-quoted path)
which no longer exists. Changed to plain text pointing at the nearest surviving
handoff (`2026-06-26-pixels-to-feet-labs.md`) so the path checker no longer
flags it as a broken reference.

### 2. `docs/knowledge/adr/0061-game-intro-screen-player-identity.md`

Used `**Status:** Accepted` (bold text) instead of the `## Status` heading
required by the checker regex `/^##\s+Status/m`. Converted to the canonical
template format.

### 3. `docs/knowledge/adr/2026-07-12-active-weapon-hud-and-per-attack-xp-attribution.md`

Same `**Status:**` → `## Status` fix.

### 4. `docs/knowledge/adr/2026-07-13-weapon-skill-level5-passive-abilities.md`

Same `**Status:**` → `## Status` fix.

## Verification

```
npx tsx scripts/agent/docs/check-adr-consistency.ts
# → docs-check-adr-consistency: 0 finding(s), 0 blocking ✅

npm run verify:fast
# → ✅ Fast verification passed (87 files, 1200 tests)
```

## Notes for future sessions

- The ADR template requires `## Status` (level-2 heading). Using `**Status:**`
  bold front-matter is NOT equivalent — the checker regex matches only the
  heading form.
- Any backtick-quoted path in an ADR that starts with `src/`, `docs/`,
  `scripts/`, etc. is validated by the checker. Historical references to files
  that were deleted/moved must be updated to plain text or point to an existing
  path.
