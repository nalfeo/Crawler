# Handoff: PR #2022 main merge silent-revert recovery

**Date:** 2026-07-29  
**Session slug:** pr2022-main-merge-silent-revert-recovery  
**Issue/PR:** nalfeo/Crawler#2022  
**Apple estimate:** 2🍎

## Systems touched

enemies, vfx, ai-behavior-tree, ci-policy

## What was done

- Unshallowed the repository, refreshed `origin/main`, and merged it into `copilot/implement-tongue-repossession-ability`.
- Resolved the shared `scripts/agent/data/boss-abilities.floor2.status.json` conflict by restoring `origin/main` as the baseline and reapplying only this PR's `big-mama-bufo-tongue-repossession` row, preserving `main`'s verified Don Paco progress instead of silently reverting it.
- Reconciled the mob-ability runtime/type/VFX/AI overlap so Bufo's lane telegraph + miss-recovery support coexists with mainline projectile-fan / slick-zone behavior.
- Restored both canonical combat-arena presets (`f2-big-mama-bufo` and `f2-don-paco`) and kept both regression tests in the merged branch.
- Fixed one coupled merge bug in `MobAbilityVfx`: projectile-fan telegraphs now use `circlesForMobAbilityGeometry(...)` during pre-draw bookkeeping, and `circlesForMobAbilityGeometry(...)` now explicitly treats lane geometry as non-circular.

## Verification

- `npm test -- --run tests/unit/mob-abilities/tongue-repossession.test.ts tests/unit/mob-ability-vfx.test.ts tests/unit/ai/mob-ability-circle-avoidance.test.ts tests/unit/boss-ability-catalog.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ⚠️ blocked by inherited invalid ledger `docs/knowledge/review-ledgers/2026-07-27-ci-liveness-sweep.review-ledger.json` already present on merged `main`, not by this PR #2022 recovery diff

## Remaining work / notes

- Finalize and push the merge commit so GitHub reruns the authoritative PR workflows on the conflict-free head.
- If CI reports fresh failures after this push, investigate the new run rather than assuming they share the previous merge-conflict root cause.
