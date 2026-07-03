# Floor 2 · Slice 6 — Settlement, seeded shops, emergent events

**Session:** `floor2-slice6-settlement-events` (cloud) · **Base:** `floor2-slice1-relationships` · **Persona:** Systems Designer / Content

## What shipped

### Content

- **`src/shared/data/quests.floor2.events.json`** — 6 authored emergent-event archetypes, transcribed from `docs/knowledge/game-design/floor2-families-and-resources.md` §9. Each event carries a static Director narration line (P6 — LLM spice is load-time only) and 1–3 faction-relation effects that reference families by **index into `world.floor2State.presentFamilies`** so the pack stays family-agnostic:
  - Turf-War Flashpoint — timer 45 s.
  - The Tribute Run — region-enter settlement.
  - The Hit — threshold cross into `hostile`.
  - Protection Racket — region-enter territory.
  - The Betrayal Tax — threshold cross into `hate`.
  - Poison the Well — timer 120 s.
- **`src/shared/data/shop-archetypes.floor2.json`** — 4 archetypes from the content bible §8: The Fence, The Apothecary, The Quartermaster, The Resource Broker. Entries reference only existing catalog ids (`weapons.json` + `SHOPKEEPER_EQUIPMENT_ITEM_ID` = `merchants-stained-charm`); the loader validates that invariant at parse-time.
- **Tuning extensions** (`src/shared/data/tuning.json`):
  - `factionRelations.eventCooldownsMs` — per-event minimum re-fire interval (all six default to 60 s; only meaningful for non-one-shot events, but plumbing is future-proof).
  - `shopPricing.floor2TierMultiplier = 1.0` — folded into every shop unit price.
- **NPC defs** (`src/shared/npc-types.ts`): **The Broker** quest-giver (dispenses `floor2-broker-family-favor` — the tutorial meta-quest per FR19) + 4 shopkeeper NPCs (`shop-the-fence`, `shop-the-apothecary`, `shop-the-quartermaster`, `shop-the-resource-broker`).

### Code

- **`src/game/systems/emergentEventSystem.ts`** — seeded, WeakMap-per-world scheduler. Deterministic (`world.elapsedMs` + `world.rng` only; no `Date.now()` / `Math.random()`). Enforces one-shot per run + per-event cooldown. Region-enter is edge-detected via `roomGraph.getRoomAt` (spatial cache, not global scan). Threshold triggers scan `world.factionRelationEvents` non-destructively so Slice 7's HUD can co-consume the same buffer. All applied effects queue via `queueFactionRelationDelta` so `familyRelationshipSystem` drains atomically next tick — deltas are never mutated in-place.
- **`src/core/generateShopInventory.ts`** — pure generator: weighted-without-replacement, deterministic per (`SeededRandom` state × archetype). `unitPrice = max(1, round(basePrice × archetype.priceMultiplier × tierMultiplier))`. Layer-safe (`core → shared/data`, no ECS dep).
- **`src/game/floor2Settlement.ts`** — `initializeFloor2Settlement(world)` retags the SETTLEMENT cavern → SAFE via `roomGraph.setRole`, seals its perimeter through `sealSpecialRooms({ extraRoomIds })` (same plumbing Floor 1 uses for the welcome office / shop room), repaints CAVE_FLOOR/STONE_FLOOR → SAFE_ROOM_FLOOR for the calm-blue tint, spawns The Broker at the centroid, and seeded-picks 1–2 shop archetypes to spawn shopkeepers via the existing `spawnNpc`. Idempotent — a second call returns the same snapshot.

### Wiring

- **Both real pipelines** now run `emergentEventSystem` immediately after `familyRelationshipSystem`:
  - Visual: `src/bootstrap/floor-main-scene-options.ts` `preSystems`.
  - Headless: `src/game/ai/simulation-step.ts`.
- Verified by `npm run check:wired-systems` (no orphan finding).
- `src/core/world.ts` gains `floor2Settlement: Floor2SettlementSnapshot | null`, initialized to `null` so every non-Floor-2 pipeline stays a no-op.

### Tests (all passing under `npm run verify`)

- `tests/unit/generate-shop-inventory.test.ts` — determinism, only-references-existing-items, price bounds, no-duplicates, seed sweep of 200 seeds × 4 archetypes.
- `tests/unit/emergent-event-scheduler.test.ts` — gating (no floor2State / non-playing state → no-op), timer trigger, threshold-into-hate trigger, one-shot enforcement (does not re-fire), `forceFireEmergentEvent` helper, determinism under a fixed seed.
- `tests/unit/quests-floor2-events-schema.test.ts` — Zod validation of the 6 events, unique ids, every `deltaKey` resolves against `tuning.factionRelations.deltas`, static narration lines, all three trigger kinds present.
- `tests/integration/floor2-settlement-broker.test.ts` — settlement init spawns Broker + 1–2 shops inside SETTLEMENT (retagged SAFE); idempotent; seeded shop rolls reproduce under same world seed; **force-fired tribute-run event, then the real headless pipeline drains the delta queue and family[0] moves by +10 (`tributeDelivered`)** — end-to-end wire proof per rule #10.

### Lab

- `src/labs/floor2-settlement-lab/index.ts` — registered as `floor2-settlement-lab` in `src/lab-main.ts`. Renders The Broker + seeded shop inventories, live faction-relation bar with band colors, event ledger showing which of the 6 emergent events have fired. Buttons: ↻ Reseed, 🎲 Reroll seed, ▶ Advance 250 ms (natural triggers), and one "★ trigger event N" button per emergent event.

## Observation (rule #10 evidence)

The integration test **`floor2-settlement-broker.test.ts > … end-to-end propagation`** is the runtime proof: it (a) seeds a Floor-2 world, (b) force-fires `floor2-event-tribute-run`, (c) runs the _actual_ `runSimulationStep` from `src/game/ai/simulation-step.ts` — not the scheduler directly — and asserts `world.factionRelationDeltas.length === 0` (drained) and `family[0]` moved by exactly `+tributeDelivered` (10 in tuning). This proves the entire chain: force-fire → deltas queued → pipeline runs `familyRelationshipSystem` → drain → relation shifted.

`npm run verify` output:

```
Test Files  14 passed | 1 skipped (15)
     Tests  75 passed | 1 skipped (76)
```

Plus wired-systems: `43 system(s) checked; all wired into a real pipeline`.

## Handoffs to sibling slices

- **Slice 4** (`floor2-slice4-bosses-dens`): `world.factionRelations` movements from emergent events will influence its door-lock / boss-den unlock quests naturally — no coordination needed. Only tuning overlap is that I added `factionRelations.eventCooldownsMs` and `shopPricing` keys; if Slice 4 lands first, rebase.
- **Slice 3** (band-driven AI): emergent-event deltas flow through `familyRelationshipSystem` before AI runs each tick, so Slice 3's AI reads consistent bands.
- **Slice 7** (HUD): the Broker + shop snapshot lives on `world.floor2Settlement`. HUD can also read `getFiredEmergentEvents(world)` for a ledger widget.
- **Slice 8** (scenario wiring): call `initializeFloor2Settlement(world)` after the map is generated and `world.floor2State` is populated. The scenario owns which family the Broker's tutorial quest pings.

## Non-goals confirmed unchanged

- `quests.floor2.dens.json` — untouched (Slice 4 owns).
- `enemy-spawner.ts` / `enemyAISystem.ts` / door-lock — untouched (Slices 3/4).
- HUD / minimap — untouched (Slice 7).
- Floor 2 scenario wiring / seed sweep — untouched (Slice 8).

## Rebase note

Base branch `floor2-slice1-relationships` is armed for auto-merge but still landing fix-forward. When Slice 1 squash-merges to `main`, run

```
git rebase --onto origin/main floor2-slice1-relationships
```

from this branch before merging.
