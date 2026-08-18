# Handoff: PR #1054 latest behind-main recovery

**Date:** 2026-07-13  
**PR:** #1054  
**PR branch:** `copilot/fix-weapon-skill-xp-misattribution`  
**Apple estimate:** 2🍎  
**Actual apples:** 2🍎  
**Verdict:** Completed

## Systems touched

hud-ux, ci-policy, docs-tooling

## Summary

Recovered PR #1054 from the latest behind-`main` blocker by merging current `origin/main` (`ee39d8df`) into the branch as a clean merge commit (`0d71d6da`).

- The new mainline delta was the merged HUD vitals polish from PR #1116; the merge required no manual conflict resolution.
- The weapon-skill attribution branch content stayed otherwise unchanged; this recovery only advanced the branch ancestry to current `main`.
- No review threads were listed in the latest recovery request, so this pass only needed the ancestry repair plus normal validation.
- Final parallel validation surfaced one real HUD-edge-case in the merged mainline code, so `computeVitalsScale` now treats a full-height cluster as max-scale-safe and `tests/unit/hud-ui-layout.test.ts` covers that boundary.
- Added a fresh 2🍎 review ledger plus this coordinating handoff so the session has its own valid recovery paperwork.

## Files touched

- `docs/knowledge/handoffs/2026-07-13-polish-vitals-hud.md`
- `docs/knowledge/metrics/apples/2026-07-13-polish-vitals-hud.json`
- `docs/knowledge/review-ledgers/2026-07-13-polish-vitals-hud.review-ledger.json`
- `src/engine/HudExperienceBar.ts`
- `src/engine/HudHealthBar.ts`
- `src/engine/HudManaBar.ts`
- `src/engine/HudUI.ts`
- `src/engine/HudVitalsLayout.ts`
- `src/engine/pixel-ui.ts`
- `tests/unit/hud-ui-layout.test.ts`
- `docs/knowledge/handoffs/2026-07-13-pr1054-latest-rebase-recovery.md`
- `docs/knowledge/review-ledgers/2026-07-13-pr1054-latest-rebase-recovery.review-ledger.json`

## Verification run

```bash
cd /home/runner/work/Crawler/Crawler
npm run verify:fast
npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-pr1054-latest-rebase-recovery.review-ledger.json
npm run verify:pr-prereqs
```
