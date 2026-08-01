# Handoff: PR CI recovery for sprite reconcile

**Date:** 2026-08-01  
**Issue/PR:** nalfeo/Crawler PR `chore(assets): reconcile queued sprite edits (395 art paths)`  
**Persona:** DevOps Engineer  
**Apple estimate:** 2🍎

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

Recovered the PR's failing unit-test blockers by restoring five corrupted
welcome-room generated PNGs to their pre-PR approved bytes and by updating
generated entry-shard `contentHash` values for every changed generated PNG that
still pointed at old bytes.

## What changed

- Restored these welcome-room PNGs from `HEAD~1`, which returned them to the
  exact dimensions and hashes their authored feet boxes and shard metadata were
  already pinned against:
  - `public/assets/generated/welcome-room-bookcase-var-0.png`
  - `public/assets/generated/welcome-room-desk-var-0.png`
  - `public/assets/generated/welcome-room-rug-var-0.png`
  - `public/assets/generated/welcome-room-shop-table-var-0.png`
  - `public/assets/generated/welcome-room-velvet-rope-var-2.png`
- Updated `contentHash` in 55 shard files under
  `public/assets/generated/entries/` so every changed generated PNG on this PR
  once again matches its declared approved bytes.

## Root cause

- The PR carried welcome-room PNG replacements whose bytes no longer matched
  the previously approved welcome-room art. Those replacements reintroduced the
  exact geometry drift that the welcome-room feet guard was written to catch.
- Separately, many generated PNGs changed without the paired shard
  `contentHash` update, so manifest metadata no longer described the shipped
  bytes.

## Verification

- Custom deterministic audit: `contentHash mismatches: 0` across all changed
  generated PNGs with shard metadata.
- Custom deterministic audit: all five restored welcome-room PNGs now match
  their `HEAD~1` bytes and expected dimensions:
  - bookcase `96x91`
  - desk `144x95`
  - rug `128x73`
  - shop table `144x85`
  - velvet rope `96x67`
- `git diff --check` ✅
- `npm run verify:fast` ❌ environment-blocked: local `node_modules` is
  incomplete (`typescript`, `@eslint/js`, and other package dependencies are
  missing), and `npm install` cannot repair it because outbound package fetches
  fail with DNS `ENOTFOUND` to `ms-feed-12.pkgs.visualstudio.com`.

## Notes

- No guard-telemetry capture was required in this session because
  `files/guard-telemetry.jsonl` was absent.
