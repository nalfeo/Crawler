# Den-boss telemetry contract

One diagnostic schema for Floor 2 den bosses, collected identically by all three
telemetry surfaces in the project. Tracked by issue #3093. Cross-system design
decision recorded in
[ADR 2026-08-18: Unified den-boss diagnostic telemetry contract](../adr/2026-08-18-den-boss-telemetry-contract.md).

## Why

Floor 2 seed 42 exposed a diagnostic split. The headless runner's
`RunStats.floor2Progression` carried lifecycle latches (`bossDefeated`,
`denUnlocked`, …) but nothing spatial; interactive player and AI Runner
recordings carried player state, kills and quests but nothing about the den at
all. A sealed-den softlock (Queen Mab could not be reached, or could not be
found) therefore could not be diagnosed from a 3,707-line recording without
tracing source. The three formats were evolving independently.

Now there is exactly one contract, and every surface emits it.

## The three surfaces

| Surface               | Entry point                                                               | Where the evidence lands                                            |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Headless / `RunStats` | `runHeadless` (`src/game/ai/headless-runner.ts`)                          | `den` `SimEvent`s via `recordEvent` **and** `RunStats.denBoss`      |
| AI Runner lab         | `createSessionRecorderControls` (`src/labs/session-recorder-controls.ts`) | `den` records in the downloaded `.jsonl`, plus `getStats().denBoss` |
| Real game (player)    | `sessionRecorderFactory` (`src/bootstrap/floor-main-scene-options.ts`)    | same as the lab — same recorder, same records                       |

All three read the same collector: `createDenBossTransitionTracker` in
`src/game/ai/den-boss-telemetry.ts` (its internal `_collectDenBossSnapshots`
builds each den's baseline observation). The lab and the real game literally
share `createPlayerSessionRecorder`, and the headless runner polls the same
tracker once per frame before its stop check.

## Schema

Pure data shapes live in `src/shared/den-boss-telemetry-types.ts` (leaf layer, so
`src/shared/session-recorder-types.ts` can reference the rollup without breaking
the layer rules). Every record stamps `schemaVersion`
(`DEN_BOSS_TELEMETRY_SCHEMA_VERSION`); bump it on any breaking field change.

### `DenBossSnapshot`

Complete state of one den at one frame — all plain JSON scalars, so it survives a
JSONL round-trip and is directly `jq`-queryable:

- **encounter lifecycle** — `encounterStarted`, `encounterDefeated`, `bossEid`,
  `lastKnownBossEid` (retained after the encounter nulls `bossEid` on defeat, so
  defeat records still identify the boss)
- **boss location vs. its den** — `bossTileX`/`bossTileY`, `bossRoomId`,
  `denRoomId`, `bossInDen`
- **visibility and health** — `bossVisible`, `bossHealthCurrent`,
  `bossHealthMax`, `bossAlive`
- **goal flag and door lock state** — `denUnlocked`, `encounterGoalActive`,
  `denDoorsTotal`, `denDoorsLocked`, `denDoorsOpen`, `denSealed`
- **player context** — `playerRoomId`, `playerInDen`

### `DenBossTransition`

Discrete state changes with `before`/`after` snapshots:
`baseline`, `den-unlocked`, `den-doors-unlocked`, `den-doors-locked`,
`player-entered-den`, `player-left-den`, `encounter-started`, `boss-left-den`,
`boss-returned-to-den`, `boss-despawned`, `encounter-defeated`,
`encounter-goal-set`, `encounter-goal-cleared`.

`baseline` is emitted once per den the first time it is observed (and again
after a tracker `reset()`), so a recording never starts from an unknown state.
Simultaneous transitions are always emitted in `DEN_BOSS_TRANSITION_ORDER`, and
dens are always iterated in `familyState.presentFamilies` order (never Map
insertion order) — the stream is deterministic across surfaces.

### `DenBossDiagnostics` (the rollup)

Accumulated inside the tracker, so it lands on `RunStats.denBoss` whether or not
a caller wired the optional event sink:

- `families[familyId]` — first/last boss eid, unlock/start/defeat frame+ms,
  `bossLeftDenCount` / `bossReturnedToDenCount`, `firstBossLeftDenMs`, and the
  `final` snapshot
- `transitions` — bounded compact log (`DEN_BOSS_ROLLUP_TRANSITION_LIMIT` = 200)
  with `transitionCount` and `transitionsTruncated`
- `eventStreamType: 'den'` — names the `SimEvent.type` that _would_ carry the
  full per-frame stream if a `den` event sink is wired. This field is always
  populated, including on headless runs with no sink at all, so it documents the
  join key rather than guaranteeing the stream exists: when no sink is wired,
  `transitions` (bounded, possibly `transitionsTruncated`) is the only surviving
  evidence and there is no `den` stream to recover the dropped entries from.

## Joining a rollup to its event stream

`RunStats.denBoss.transitions[]` and the `den` records share `familyId` + `frame`

- `gameMs`. Given a run's `RunStats` and its `.jsonl`:

```bash
# every transition for one den, in order
jq -c 'select(.type == "den" and .denBoss.familyId == "fae") | {frame, kind: .denBoss.kind}' session.jsonl

# was the den ever sealed while the boss was outside it?
jq -c 'select(.type == "den") | .denBoss.dens[] | select(.denSealed and .bossInDen == false)' session.jsonl
```

The periodic aggregate record (`kind: "snapshot"`, `familyId: null`) carries
every den on the floor; transition records carry only the affected den plus its
`before` snapshot.

## Relationship to `floor2Progression`

`RunStats.floor2Progression` is unchanged and remains the coarse per-family
progression summary (quest/objective latches). `RunStats.denBoss` is the
spatial/diagnostic layer keyed by the same `familyId`, so the two join directly.
They deliberately live side by side rather than nesting: `floor2Progression` is
headless-only, while `denBoss` is produced identically by all three surfaces.

## Cost

`_hasDenBossTelemetry` short-circuits on any world without
`floorExtendedState.familyState.bossEncounters`, so non-den floors pay nothing —
no records, no `denBoss` key on `RunStats` or recorder stats. Interactive
recorders materialize the aggregate snapshot only on the `denSampleInterval`
cadence (default `sampleInterval * 4`); transition detection itself reads a
handful of components per den per frame.

## Tests

| What it proves                                               | Where                                              |
| ------------------------------------------------------------ | -------------------------------------------------- |
| Collector/tracker behavior against the real Floor 2 systems  | `tests/game/den-boss-telemetry.test.ts`            |
| All three surfaces produce equivalent evidence (AC1–AC4)     | `tests/game/den-boss-telemetry-contract.test.ts`   |
| `runHeadless` really emits `den` events + `RunStats.denBoss` | `tests/headless/floor2-den-boss-telemetry.test.ts` |

The shared deterministic seed-42 Floor 2 den world used by the first two lives in
`tests/helpers/floor2-den-fixture.ts`; it drives the production
`floor2ObjectiveTick` pipeline rather than hand-setting encounter state.
