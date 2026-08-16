# Session Handoff: Floor 1 Bow-35 Release Regression

## Date

2026-08-15

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual

## Summary

Fixed the Floor 1 release sweep loss for the exact signature
`floor=floor1|leg=floor1|forceWeapon=true|chained=false|damage=1|seed=35|weapon=bow`
without weakening sweep or gameplay requirements.

Root cause: while healthy projectile weapons can keep travelling toward remote NPC
objectives because auto-fire handles nearby threats, the behavior tree applied that
same bypass when the player was wounded. In the failing bow-35 run, the AI kept
trying to route to the Spell Broker / shopkeeper chain under local pressure and
entered a low-HP progress/retreat oscillation.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
  - Wounded projectile users now fall through to the existing
    `shouldClearThreatBeforeNpc` path before long NPC approach routes.
  - Healthy projectile users still bypass the threat clear and continue travelling
    toward the NPC, preserving the previous ranged auto-fire behavior.
- `tests/game/behavior-tree-ai.test.ts`
  - Added focused unit coverage for wounded bow/fireball users clearing nearby
    threats before remote NPC routes, alongside the existing healthy projectile
    regression.
- `tests/headless/floor1-bow35-release-regression.test.ts`
  - Added a real headless regression for forced bow seed 35 with paired
    deterministic reruns.
- `docs/knowledge/review-ledgers/2026-08-15-floor1-bow35-release-regression.review-ledger.json`
  - Recorded the required 3🍎 review harness: plan review, code-review loop, and
    independent grade.

## Verification run

- Required issue-plan comment posted before coding on issue #2968.
- Pre-fix real-pipeline observation:
  - `npm run ai:headless:tsx -- --seed 35 --weapon bow --max-frames 23760 --max-time-ms 300000 --enemy-damage-multiplier 1 --floor floor1 --event-log /tmp/bow35-before.jsonl --event-summary /tmp/bow35-before-summary.json --progress 0 --weapon-telemetry`
  - Result: `DEATH` at frame 16,626 / 277.1s.
- Post-fix real-pipeline observation:
  - Same forced bow seed 35 headless configuration.
  - Result: `VICTORY` at frame 22,060 / 367.7s, minimum HP 28.8%.
- `npx vitest run --project unit tests/game/behavior-tree-ai.test.ts --reporter=dot`
  - 119 tests passed.
- `npx vitest run --project headless tests/headless/floor1-bow35-release-regression.test.ts --reporter=verbose`
  - 1 test passed.
- `npm run verify:fast`
  - Passed from final HEAD.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-15-floor1-bow35-release-regression.review-ledger.json`
  - Valid 3🍎 ledger.
- Automated code review: no comments.
- CodeQL checker: no alerts returned; JavaScript analysis reported skipped due to
  database size.
- Secret scanning: no secrets in changed files.

## Review harness notes

The human-facing plan was posted to issue #2968 before coding, as requested. The
separate-model plan review required by the 3🍎 ledger was accidentally run after
implementation; this timing mistake is recorded explicitly in the ledger notes.
The reviewer approved the design with changes, and the projectile-wide wounded
behavior concern was addressed by expanding the unit regression from bow-only to
bow plus fireball while preserving existing healthy projectile coverage.

## Unresolved issues

None known for this fix. The broad release sweep requirement remains unchanged;
CI/release automation should continue to enforce the 100% Floor 1 gate.

## Recommended next steps

- Let CI run the full required checks on the PR.
- If another Floor 1 release signature appears, start from exact real headless
  reproduction and event-log inspection rather than tuning weapon balance or
  relaxing sweep gates.
