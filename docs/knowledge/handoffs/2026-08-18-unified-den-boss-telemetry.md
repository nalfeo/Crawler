# Session Handoff: unified den-boss telemetry

**Date:** 2026-08-18  
**Session slug:** unified-den-boss-telemetry  
**Apple estimate:** 3🍎

## Systems touched

boss-rooms, ai-behavior-tree, devtools, docs-tooling

## What Was Done

Closed the diagnostic split that made the Floor 2 seed-42 Queen Mab softlock
undiagnosable (issue #3093) by giving all three telemetry surfaces one shared
den-boss contract.

- `src/shared/den-boss-telemetry-types.ts` — pure schema (`DenBossSnapshot`,
  `DenBossTransition`, `DenBossDiagnostics`, `DenBossEventPayload`) with an
  explicit `DEN_BOSS_TELEMETRY_SCHEMA_VERSION`. It lives in the leaf layer so
  `src/shared/session-recorder-types.ts` can reference the rollup without
  breaking the layer rules (same split as `weapon-telemetry-types.ts`).
- `src/game/ai/den-boss-telemetry.ts` — the single world-reading collector and
  transition tracker. Snapshots cover encounter lifecycle, boss tile/room vs.
  den (`bossInDen`), visibility and health, the encounter goal flag, and den
  door lock state (`denSealed`).
- `src/game/ai/event-log.ts` — new `'den'` `SimEvent` type + `isDenSimEvent`.
- `src/game/ai/player-session-recorder.ts` — the real game and the AI Runner lab
  (same recorder) now emit `den` records into the downloadable JSONL and expose
  `getStats().denBoss`.
- `src/game/ai/headless-runner.ts` / `types.ts` / `run-stats-collector.ts` —
  `runHeadless` polls the same tracker each frame, emits `den` events, and sets
  `RunStats.denBoss` at both return sites; the human `collectHumanRunStats` path
  carries the identical rollup.
- Documented the contract, the join between rollup and event stream, and its
  relationship to `floor2Progression` in
  `docs/knowledge/telemetry/den-boss-telemetry-contract.md`.

## Observation

Before: a Floor 2 session recording contained zero den fields — nothing about
boss position, den doors, or the unlock goal — so a sealed-den softlock could
only be investigated by tracing source.

After, on the real artifacts (not a lab): a `runHeadless` Floor 2 seed-42 run
emits `den` records and a populated `RunStats.denBoss`
(`tests/headless/floor2-den-boss-telemetry.test.ts` asserts both against the
real pipeline), and the real-game recorder factory
(`createFloorMainSceneOptions('floor2').sessionRecorderFactory`) produces a JSONL
whose den records carry the full `baseline → den-unlocked → encounter-started →
boss-left-den → encounter-defeated` lifecycle with door-lock and `bossInDen`
state on every record. The cross-path test asserts the recorder rollup and the
headless rollup are deeply equal for the same world states.

## Verification

- `npx vitest run tests/game/den-boss-telemetry.test.ts --project unit` — 11 passed
- `npx vitest run tests/game/den-boss-telemetry-contract.test.ts --project unit` — 5 passed
- `npx vitest run tests/headless/floor2-den-boss-telemetry.test.ts --project headless` — 2 passed
- `npm run verify:fast` — green (139 files, 2296 tests)

## Review

The 3🍎 plan review, code-review loop and independent grade are tracked in
`docs/knowledge/review-ledgers/2026-08-18-unified-den-boss-telemetry.review-ledger.json`.

## Unresolved issues

`npm run docs:check` fails on two **pre-existing, unrelated** items on this
branch's base: `.github/agents/ux-designer.agent.md` references
`files/visual-review/reviews/*.review.json` and `docs/knowledge/ux-feedback/`
(that directory is off-limits to coding-agent sessions), and ADR 0086 references
`scripts/sprites/normalize-item-art-names.ts` in the very sentence that records
the file's deletion — the path checker does not understand "is deleted". Neither
is touched by this change; both need a docs-tooling fix rather than an ADR
rewrite.
