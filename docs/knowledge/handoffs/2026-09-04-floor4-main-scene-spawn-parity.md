# Session Handoff: Floor 4 MainGameScene physical spawning parity

## Date

2026-09-04

## Persona

Producer coordinating Systems/Game AI/QA concerns.

## Systems touched

enemies, hud-ux, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact — code/test touch across the shipped MainGameScene probe, Floor 4 physical-spawn acceptance, e2e/headless validation, and 4-apple review requirements).

## Summary

Closed the observable gap in Floor 4 slice 2's acceptance contract: the existing seed-404 headless gate and visual AI-runner gate already proved the arena director could release the full authored wave manifest, spawn Headliners, and advance through the shared Floor 4 scenario path, but the normal shipped `MainGameScene` probe path could not boot the canonical seed 404 or report live physical hostiles. That left issue #4142's “too few enemies / infrequent waves” consolidation criterion vulnerable to a false pass from a non-canonical or under-instrumented visual trace.

## Files touched

- `src/labs/main-scene-probe-lab/index.ts`
  - Added a `?seed=` query override so the probe can boot the same canonical seed as the shipped game entrypoint and Floor 4 completion gates.
  - Exposed read-only MainGameScene state for `worldSeed`, `frameCount`, `elapsedMs`, live `Enemy` count, live positive-HP hostile count, and `floor4Arena` telemetry via the existing probe API.
  - Did not add or duplicate Floor 4 gameplay behavior; the probe still boots through `createFloorGameConfig` + `createFloorMainSceneOptions`.
- `tests/e2e/floor4-main-scene-spawning.deterministic.test.ts`
  - Added a focused real MainGameScene e2e regression at `floor=floor4&seed=404`.
  - Unpauses the shipped scene path, waits for Act 1 `WAVES`, and asserts at least one wave released, enemies spawned, and live hostile entities exist.

## Verification run

- `bash scripts/agent/preflight.sh` — passed (typecheck included).
- `npx vitest run --project headless tests/headless/floor4-arena-completion.test.ts --reporter=verbose` — passed; 2 passed + 1 expected fail.
- `npx vitest run --project e2e tests/e2e/floor4-ai-completion.deterministic.test.ts --reporter=verbose` — passed; 1 passed + 1 expected fail.
- `npx vitest run --project e2e tests/e2e/floor4-main-scene-spawning.deterministic.test.ts --reporter=verbose` — passed; observed physical hostiles in the real MainGameScene probe path for seed 404.
- `npx tsc --noEmit --pretty false` — passed.
- `npx vitest run --project e2e tests/e2e/floor4-main-scene-spawning.deterministic.test.ts tests/e2e/floor4-arena-hud.deterministic.test.ts --reporter=verbose && npx vitest run --project headless tests/headless/floor4-arena-completion.test.ts --reporter=verbose` — passed.
- `runtime-tools-secret_scanning` on changed files — no secrets detected.
- `npm run verify:fast` — passed (long changed-test sweep, exit 0).

## Run bundle evidence

Run bundle `31f7448f-95bb-46d3-a128-272152316a28` was treated as primary evidence per the run-bundle-analysis workflow, but it was unavailable from this sandbox: unauthenticated GitHub API access returned 403, `gh issue view` had no token, and the trusted storage host could not be DNS-resolved for the unsigned object. Do not treat that bundle as clean; the local regression instead proves the narrow acceptance signal requested here from the current code path.

## Key decisions made

- Preserved `ScenarioDefinition` as the authority. No headless-only, visual-only, or probe-only spawn/phase/combat/reward/intermission behavior was added.
- Kept the change observational and surgical because current headless and visual AI-runner seed-404 gates already pass the ordered Floor 4 phase/spawn/Headliner/intermission contract up to the known C5 expected-failure characterization.
- Chose a deterministic e2e MainGameScene probe instead of tuning wave cadence or enemy counts from one unavailable bundle; balance/population claims still need playtest/sweep evidence.

## Unresolved issues

- The existing C5 expected-failure remains by design: Floor 4 intermissions/stairs still resolve through the shared arena-director timer (`slice2-auto-green-room-exit` / `slice2-auto-stairs`), not a public Green Room/stairs interaction. This session did not implement slice 5.
- The referenced run bundle could not be parsed in this sandbox, so bundle-specific narrative/telemetry findings remain unknown.

## Recommended next steps

- If the signed run bundle is needed for deeper diagnosis, rerun run-bundle analysis in an environment with GitHub issue read credentials and DNS access to the trusted Crawler storage origin.
- Keep future Floor 4 Green Room/stairs work updating both headless and visual gates together, removing the current C5 expected-failure only when a real public scenario/UI interaction exists in the shared scenario path.
