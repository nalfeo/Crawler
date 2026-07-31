# Session Handoff: Restore Tier1 Floor 2 accessory eligibility

## Date

2026-07-31

## Persona

Game Designer

## Systems touched

quests, inventory, weapons

## Apples

2🍎 estimated, 2🍎 actual (exact)

## What Was Done

Fixed the Floor 2 achievement reward path so tier1 rewards are no longer hard-locked to
weapon-only outcomes by the combination of a tiny authored base list and the old
"any non-armor stat is illegal" Common contract.

- Added `src/shared/data/floor2-reward-pool.ts`, a shared Floor 2 achievement reward pool
  built from the existing Floor 2 weapon Wave A ids plus the mixed weapon/non-weapon Wave B ids.
- Switched the shipped `FLOOR2_ACHIEVEMENT_CATALOG` to use that shared reward pool at load time
  instead of the repeated four-weapon list from `achievements.floor2.json`.
- Replaced the Common-tier structural base check in
  `src/game/floor2-reward-bundle-resolver.ts` with a stat-modest rule:
  Common rewards may carry **at most one modest inherent non-armor stat bonus**.
- Added focused regression coverage proving:
  - shipped Floor 2 achievement rewards now use the shared mixed pool;
  - the shared pool includes accessory bases;
  - modest accessory bases such as `accessory.compass-charm` / `accessory.surveyor-map`
    are legal for tier1 Common rewards;
  - stacked accessory-style bases such as `travelers-cloak` still fail closed with `illegal-base`.

## Key Decisions Made

- **Use one shared reward pool constant instead of editing 36 JSON entries.**
  This keeps the diff surgical while removing the repeated placeholder weapon list from the
  runtime catalog.
- **Relax the Common contract by magnitude, not by category.**
  The old rule accidentally banned every accessory because accessories exist to carry
  non-armor bonuses. The new rule still preserves "tier1 is modest" by allowing only a
  single capped non-armor bonus.
- **Keep the change local to shipped Floor 2 content.**
  `createAchievementCatalog()` stays generic for tests and synthetic catalogs; only the
  shipped `FLOOR2_ACHIEVEMENT_CATALOG` gets the shared Floor 2 reward pool override.

## Files Changed

- `src/shared/data/floor2-reward-pool.ts`
- `src/shared/achievements.ts`
- `src/game/generated-equipment-generator.ts`
- `src/game/floor2-reward-bundle-resolver.ts`
- `tests/unit/achievements.test.ts`
- `tests/unit/floor2-reward-bundle-resolver.test.ts`
- `docs/knowledge/review-ledgers/2026-07-31-floor2-tier1-accessory-pool.review-ledger.json`

## Verification

- `runtime-tools-secret_scanning` on all changed code/test files → no secrets detected
- `bash scripts/agent/lab-gate-check.sh` → pass
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-31-floor2-tier1-accessory-pool.review-ledger.json`
  → valid 2-apple ledger
- `npm run verify:fast` → blocked locally because repo dev dependencies are not installed
  in this sandbox (`typescript`, `vitest`, `@eslint/js`, `zod`, etc.)
- `npm run test -- tests/unit/floor2-reward-bundle-resolver.test.ts tests/unit/achievements.test.ts`
  → blocked locally because `vitest` is unavailable in `node_modules`
- `tsc -p tsconfig.json --noEmit` (global TypeScript) → full-project run still blocked by
  missing repo dependencies; after fixing one local non-null issue from the filtered output,
  remaining changed-file errors were dependency-driven (`zod` / `vitest` missing)

## Unresolved Issues / Blockers

- Could not post the requested pre-code implementation-plan comment on issue #2405 from this
  sandbox. Local `gh auth status` reported an invalid `GITHUB_TOKEN`, and the repo's own
  CI-recovery tooling notes that repair agents may lack `issues:write`.
- Could not complete local `verify:fast` / Vitest execution because this clone is missing repo
  dev dependencies and `npm install` fails in the sandbox with upstream mirror/network errors.

## Recommended Next Steps

- Let CI run the normal TypeScript/lint/test gates on the pushed branch, since local validation
  is dependency-blocked here.
- If the maintainer still wants the issue-level plan comment for audit purposes, have a trusted
  actor with `issues:write` post it (the CI recovery pipeline already has a retroactive path for
  this case).
- After this lands, re-measure the resulting Floor 2 tier composition; if the pool still feels
  too weapon-heavy, treat category weighting as a separate balance pass.
