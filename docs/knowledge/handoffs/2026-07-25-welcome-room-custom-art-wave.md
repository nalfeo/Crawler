# 2026-07-25 — Welcome Room custom-art wave (14 requests)

Generated, judged, approved, checked in and **wired** the 14 `custom` art
requests the `welcome-room` set piece was waiting on. The room previously
rendered with grey pending-art stand-ins; it now renders entirely as real art.

Pending custom-art requests for `welcome-room`: **14 → 0** (verified in the
set-piece lab render, not from the manifest diff).

## Systems touched

- **Sprite pipeline (art)** — 14 briefs (`briefs/props/welcome-room-*.yaml`,
  `briefs/tiles/welcome-room-floor-*.yaml`), generated on the Azure sidecar,
  deterministic sensors + VLM judge, approved and checked in
  (issue #1986, branch `assets/checkin-20260725-072019-8b6182`).
- **Set piece data** — `src/shared/data/set-pieces.json`: the 24 `custom` layer
  refs on `welcome-room` rewritten to `catalog` refs pointing at the approved
  variants. This is the wiring step; set-piece custom refs do **not**
  auto-resolve from the manifest.
- **Sprite catalog / manifest** — `src/shared/data/sprite-catalog.json`,
  `public/assets/generated/manifest.json` + 14 PNGs.
- **Tests** — `tests/unit/set-piece-types.test.ts`: the welcome-room wiring test
  asserted the _pre-art_ state (14 outstanding requests, three decor props still
  `custom`). Now that the art ships, it asserts the stronger inverse invariant:
  zero outstanding requests, and each formerly-queued decor prop resolving to a
  catalog id matching `^<bare-requestId>-var-\d+$`.

## Gotchas worth remembering

- **Set-piece `custom` refs never auto-resolve.** `collectCustomArtRequests`
  counts `source: 'custom'` layers unconditionally. Check-in alone leaves the
  room rendering stand-ins; the refs must be rewritten to `catalog`.
- **Catalog `id` carries a `generated:` prefix; set-piece `spriteId` must be the
  bare id.** Wiring with the prefixed id resolves to no texture and renders as a
  grey box with **no console error** — a silent failure. Always eyeball the
  render.
- **Brief the floor against the floor, not the rug.** The four carpet tiles were
  first briefed to match `welcome-room-rug-var-0` (deep maroon) and came back at
  `#933c1a`/`#a76521` against a baked floor of `#eaa56c` — they rendered as dark
  patches punched into the carpet, which is the exact failure they were
  commissioned to remove. Sampling the _rendered_ floor colour and putting that
  hex in the brief fixed all four.
- `sprites:run` does not load `.env.local`; preload it. The CLI flag is
  `--judge-budget-usd`. Azure image sizes are limited to 1024²/1024×1536/1536×1024.
- **Sheet-slicer collapse** (whole sheet returned as one "variant") is caused by
  the model drawing per-cell alternating background colours. Fix in the brief:
  demand one flat uniform background identical in all cells.
- `sprites:checkin` refuses to re-queue a filename with different content while
  an earlier check-in issue is open. Close/supersede the old issue and branch.

## Known-good / still open

- `npm run setpiece:score -- welcome-room` → **10/11**. The single failure,
  `Shell integrity`, is **pre-existing and unrelated to this art wave** —
  reproduced by stashing every file this wave touched. It needs a dressing pass
  (perimeter wall/door props), which is set-piece design work, not art.

## Apples

**~3🍎.** Mostly art (review-ledger-exempt), but it grew a code-touching tail:
the set-piece wiring and the test update.
