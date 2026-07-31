# Handoff: PR #2365 merge-conflict recovery

**Date:** 2026-07-31  
**Session slug:** pr-2365-merge-conflict-recovery  
**Apple estimate:** 🍎🍎

## Summary

Recovered PR #2365 from the active `origin/main` merge conflict.

- merged current `origin/main` into the PR branch
- kept the inventory-lane accessor import in `MainGameScene` while preserving
  mainline quartermaster/settlement-shop imports
- resolved the `ui-probe-lab` overflow-bag helper by rebuilding the bag through
  `createInventoryBag()` instead of mutating `bag.slots`, while preserving any
  existing `generatedEquipmentCapacity`

## Systems touched

inventory, hud-ux

## Validation

- `git merge --no-ff origin/main` ✅
- `npm run verify:fast` ⚠️ blocked before project checks because sandbox deps are
  not installed
- `npm ci` ⚠️ blocked by `getaddrinfo ENOTFOUND
  ms-feed-12.pkgs.visualstudio.com` while downloading `path-scurry-2.0.2.tgz`

## Notes

- The merge commit is `2bcd7ae6`.
- Local package-backed validation is currently blocked by the sandbox's npm
  mirror reachability, so CI is the first authoritative post-merge validation
  pass for this recovery.
