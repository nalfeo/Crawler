# Handoff: terrain bake CI recovery

## Date

2026-08-02

## Persona

DevOps Engineer

## Systems touched

mapgen

## Apples

2🍎 exact

## Summary

Recovered PR #2694's remaining CI blockers after the terrain bake optimization landed:

- fixed stale welcome-room set-piece feet metadata in
  `src/shared/data/set-pieces.json` so the renderer-facing width/height contract
  matches the shipped generated art again;
- corrected the four affected upright props in both welcome-room variants
  (`shop-table`, `welcome-desk`/`broker-desk`, `broker-bookcase`,
  `velvet-rope`);
- restored `docs/knowledge/handoffs/INDEX.md` to the merge-base version so the
  branch no longer carries the forbidden generated index diff that blocks
  `verify:pr-prereqs`.

## Validation

- `npm test -- --run tests/unit/set-piece-declared-feet.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` (after staging the `INDEX.md` reversion; expected to
  go green once the repair commit updates `HEAD`)

## Notes

- Local dependency installation initially failed because `package-lock.json`
  still referenced unreachable `ms-feed-*.pkgs.visualstudio.com` tarball URLs.
  I temporarily rewrote those URLs in the working tree to `registry.npmjs.org`
  only long enough to run `npm ci`, then restored `package-lock.json` before the
  final diff.
