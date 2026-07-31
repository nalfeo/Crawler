# Session Handoff: PR #2365 generated-art and guard recovery

## Date

2026-07-31

## Persona

Producer

## Systems touched

inventory, engine, ci-policy

## Apples

2 apples estimated, 2 apples actual.

## Summary

Recovered the two blockers called out by CI for PR #2365:

- `src/engine/InventoryUI.ts` now resolves fallback generated-instance art by the instance base item id, while still preferring a loaded direct `frozen.artKey` texture when present. This restores the generated-only bag render path exercised by `tests/integration/inventory-ui-item-art.test.ts`.
- `scripts/agent/health/test-only-exports.ts` now treats underscore-prefixed exports as intentional test scaffolding, matching the shared library logic and unblocking the `equipment-slots.ts` guard findings.

## Validation

- Investigated failing GitHub Actions jobs `91068317481`, `91068317502`, and `91069607140`.
- `git diff --check`
- Local package-backed verification was blocked in this sandbox because `npm ci` failed to resolve `ms-feed-12.pkgs.visualstudio.com` while fetching `path-scurry-2.0.2.tgz`, so the rerun of targeted Vitest / guard commands must happen in CI.

## Notes

- The integration failure was a narrow art-resolution issue, not a missing generated-entry render path: the grid already included generated entries, but the icon fallback was resolving by `artKey` instead of the base item concept.
- The test-only-export regression lived only in the CLI wrapper; `test-only-exports-lib.ts` and its unit tests already recognized underscore-prefixed scaffolding.
