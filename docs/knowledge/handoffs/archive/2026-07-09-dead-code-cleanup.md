# Session Handoff: Dead code cleanup

## Date

2026-07-09

## Persona

Producer

## Systems touched

ci-policy, sprite-pipeline, sprite-workflow, mapgen, ai-behavior-tree, devtools, lighting, vfx, enemies, inventory

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎🍎
- Verdict: 📉 Under

## What Was Done

Tightened `npm run lint:dead-code` from dependency-only Knip to a real dead-code pass (`dependencies,exports,files`), tuned `knip.json` so dynamic lab entrypoints and intentional public roots are treated as live, and aligned `VERIFY_KNIP=1` in `scripts/agent/verify.sh` to call the same lint command. Then removed the unused `scripts/sprites/make-pixel-art.ts` file and trimmed/de-exported stale helpers/constants across sprite tooling, core/game/engine/shared modules, labs, and test fixtures until `npm run lint:dead-code` returned clean again.

## Key Decisions Made

- Kept the stronger Knip gate advisory inside default `verify`; the change tightens signal quality, not CI strictness.
- Counted test imports in Knip by adding `tests/**/*.ts` to project scope so test-only live usage stops looking dead.
- Treated dynamic labs and a short list of public barrels/CLI roots as Knip `entry` files rather than deleting them, because those modules are intentionally loaded indirectly.
- Accepted the broad but mechanical export-trim diff once `npm run verify:fast` proved behavior stayed intact; documented the policy in ADR 0054.

## Verification Run

- `npm run lint:dead-code` ✅
- `npm run verify:fast` ✅
- `npm run verify` ✅ after adding ADR 0054 and this handoff

## What's Next / Blockers

- No functional blockers remain in this slice.
- Future refactors that add new dynamic entry roots or intentional public barrels should update `knip.json` deliberately instead of silencing findings ad hoc.

## Retrospective

### Lessons Learned

- The biggest gap was not stale code itself; it was the false-clean metric. Tightening the gate first made the cleanup legible.
- Knip's built-in fixer is effective once false-positive entry roots are modeled honestly; without that modeling it is too blunt.
- Including tests in Knip scope is necessary in this repo because many helper exports are only exercised through tests and labs.

### Mistakes Made

- I initially relied on the stricter Knip report without accounting for dynamic lab loading and public barrels, which produced a noisy first pass.
- I also hit the PR-prereq ADR/handoff guard late in full verify instead of creating those artifacts earlier once the diff crossed multiple architectural layers.

### Opportunities for Future Improvement

- Add a focused docs/tooling note or check around when a module should become a Knip `entry` root versus when it should be deleted or de-exported.
- Consider a narrower repo convention for intentionally public schema constants to avoid broad "export it just in case" surfaces growing back.
