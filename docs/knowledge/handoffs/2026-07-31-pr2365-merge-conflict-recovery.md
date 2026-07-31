# PR #2365 merge-conflict recovery

## Date

2026-07-31

## Persona

Producer

## Systems touched

inventory, ci-policy

## Apples

Estimated: 2🍎. Actual: 2🍎. Verdict: exact.

## What changed

- Merged `origin/main` into `copilot/guard-make-two-lane-inventory-unrepresentable`.
- Resolved the branch-vs-main conflict around shared mirror-slot metadata by
  restoring `src/shared/mirror-slot-metadata.ts`, preserving main's barrel
  side-effect import, and re-exposing the mirror-slot metadata symbols from
  `src/shared/equipment-slots.ts`.
- Kept the branch's newer snapshot-based `test-only-exports` guard wrapper so
  the inventory-lane recovery branch does not regress its newly-test-only export
  detection during the merge.
- Fixed trailing whitespace introduced by an upstream handoff file so the merge
  tree passes `git diff --check`.

## Files touched

- `scripts/agent/health/test-only-exports.ts`
- `src/shared/equipment-slots.ts`
- `src/shared/index.ts`
- `src/shared/mirror-slot-metadata.ts`
- `docs/knowledge/handoffs/2026-07-30-probe-boss-chest-floor1-silent-noop.md`
- `docs/knowledge/handoffs/2026-07-31-pr2365-merge-conflict-recovery.md`

## Validation

- `git diff --check --cached`
- `npm run verify:fast` ⚠️ environment-blocked: local dependencies are not
  installed in this sandbox, and both preflight and `npm ci` fail on
  lockfile-resolved package host DNS (`ms-feed-12.pkgs.visualstudio.com`,
  `getaddrinfo ENOTFOUND`).

## Unresolved issues

- Package-backed local verification remains blocked in this sandbox until the
  lockfile-resolved feed host is reachable or dependencies are preseeded.

## Recommended next steps

- Push this merge-recovery commit so CI can run the first authoritative
  validation pass on the merged branch head.
