# Handoff — Welcome Room four-prop art wave (2026-07-27)

Asset Forge / Graphics Designer persona. Pure-art wave: four new props for the Floor 1
`welcome-room` set piece. Brief → generate (Azure sidecar) → judge → approve → check-in →
art-only PR. **No wiring, no engine change** — review-ledger exempt.

Apple score: **4🍎** (four subjects, four generation rounds, one palette authoring).

## Systems touched

- `briefs/props/` — four new sprite briefs (art-only inputs, not runtime code)
- `data/palettes/` — one new palette ramp (`welcome-room-faded-runner.json`)
- `public/assets/generated/` + `manifest.json` — four approved PNGs (via check-in branch)
- `src/shared/data/sprite-catalog.json` — four catalog entries (via check-in branch)
- **Not touched:** `src/shared/data/set-pieces.json`, engine, renderer. Wiring is a separate code PR.

## Shipped

| Prop             | Approved id                         | PNG px  | Drawn box      | Judge (DL/RSM/BM/RD/PR) |
| ---------------- | ----------------------------------- | ------- | -------------- | ----------------------- |
| Floor runner     | `welcome-room-floor-runner-var-10`  | 100x192 | 80x172 (0.465) | 4/4/5/5/5               |
| History board    | `welcome-room-history-board-var-3`  | 84x108  | 74x90 (0.822)  | 4/4/5/5/5               |
| Exit sign (wall) | `welcome-room-exit-sign-wall-var-2` | 80x59   | 72x51 (1.412)  | 4/4/5/5/5               |
| Door             | `welcome-room-door-var-2`           | 96x128  | 82x114 (0.719) | 4/4/5/5/5               |

All four: 7/7 deterministic sensors AND VLM judge pass. `npm run check:tile-mattes` clean
(386 sprites checked, no magenta matte, 0 blocking findings).

Check-in issue **#2088**, art-only PR **#2090** (auto-merge armed, squash).

## Suggested `set-pieces.json` values (renderer is height-authoritative)

- `welcome-room-floor-runner-var-10` — `widthFt: 4`, `heightFt: 8.6`
- `welcome-room-history-board-var-3` — `widthFt: 3.7`, `heightFt: 4.5`
- `welcome-room-exit-sign-wall-var-2` — `widthFt: 2.5`, `heightFt: 1.77`
- `welcome-room-door-var-2` — `widthFt: 5.03`, `heightFt: 7`

Derive one axis from the measured drawn aspect; never hand-type both (contain-fit's
`Math.min` silently discards the looser one).

## Honest failure: aspect ratios did not converge

Three of four props never reached their briefed aspect after 3–4 rounds:

| Prop         | Briefed         | Shipped              | Rounds                                       |
| ------------ | --------------- | -------------------- | -------------------------------------------- |
| Floor runner | 0.333 (4x12 ft) | 0.465 (~8.6 ft long) | 4                                            |
| Exit sign    | 2.5             | 1.412                | 3 (round 3 regressed — judge rejected all 8) |
| Door         | 0.5             | 0.719                | 3                                            |

**No sensor threshold and no judge bar was touched.** The judge itself flags the deviation in the
door's `briefMatch` rationale. This is a model-prior limitation on extreme aspects, not a gate
problem.

Levers tried, in order of effectiveness:

1. **Explicit source-pixel bounding-box targets inside the 256x256 cell** — the only lever the
   model reliably obeys, but only on **one axis at a time** (asked for 78 px wide → got exactly
   78; asked for 236 px tall in the same breath → got 172).
2. Per-axis prose corrections ("does the width fit twice inside the height?") — modest gain on
   the door (0.89 → 0.719), regression on the runner.
3. **Palette lock** (`paletteMode: strict`) — the deterministic fix for "too saturated/warm".
   Rescued the runner's colour completely; does nothing for aspect.

Untried escalation for a future wave: custom `generation.sheet.rows/cols` producing natively
**non-square** cells, so the model composes into a portrait/landscape frame instead of fighting a
square one. That is the recommended next lever, not more prose.

## Rules re-confirmed this wave

- `sizeVariant: tall` remains **banned on props** (prior wave's stacked-column failure that passed
  all 7 sensors AND the judge). Same caution extended to `wide`; used default square cells and
  drove proportion via prose plus pixel targets.
- `resizeSpriteStrategy` (`scripts/sprites/size-variants.ts:68`) decides letterboxing. Canvases
  that trigger `height`/`width` keep the shipped PNG aspect-true to the drawn art — which is why
  shipped widths are 100/96 px, not the declared 64. Working as designed.
- `opaqueRatio` prop default `[0.10, 0.65]` is tuned for irregular open silhouettes. Near-
  rectangular flat subjects (boards, signs, carpets, doors) need a higher cap; set **before**
  generating, from subject geometry, precedent 0.88 (`welcome-room-show-poster`). A real
  background-removal failure still lands ~0.95–1.0 and is caught.
- Wall-mounted props need `anchor.mode: center-of-mass`; grounded props keep `derive: true`.
- Env preload does not persist across PowerShell calls — preload `.env.local` in the _same_ call as
  `sprites:run`. Run a throwaway warmup brief first to dodge the cold-call `fetch failed` flake.

## Prior-wave tracking (resolved)

Issue **#2070** CLOSED, PR **#2071** MERGED, PR **#2084** MERGED. `welcome-room-floor-scuff-var-4`
landed. Nothing stranded.

## Open doc debt (carried, still unfixed)

- `docs/knowledge/game-design/set-piece-lookbook.md` says "1 tile = 2 feet"; code says
  `tileSizeFt: 4.0` with `PIXELS_PER_FOOT = 8`.
- `docs/knowledge/handoffs/2026-07-26-stone-floor-art-wave.md` contains unresolved merge-conflict
  markers.
