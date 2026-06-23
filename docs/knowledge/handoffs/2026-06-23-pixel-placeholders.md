# Handoff: Pixel Placeholder Sprites for All Items

**Date:** 2026-06-23
**Persona:** Graphics Designer

## What Was Done

Generated simple 16×16 pixel-art placeholder PNGs for every item in the catalog
that did not yet have an approved sprite. No AI API required.

## New Script

`scripts/sprites/gen-placeholders.ts` — driven by `npm run sprites:gen-placeholders`

Flags:

- `--dry-run` — preview without writing any files
- `--force` — overwrite entries that already exist (including existing placeholders)

The script skips any item whose `manifest.json` entry has a `sourceRun` value
other than `"placeholder"` (i.e. a real AI-approved sprite) unless `--force` is
passed.

## Items Covered (13 placeholders)

| Item ID                   | PNG file                                |
| ------------------------- | --------------------------------------- |
| `iron-ore`                | iron-ore-placeholder.png                |
| `rusted-scrap`            | rusted-scrap-placeholder.png            |
| `old-sock`                | old-sock-placeholder.png                |
| `bone-shard`              | bone-shard-placeholder.png              |
| `pebble`                  | pebble-placeholder.png                  |
| `glistening-rat-tail`     | glistening-rat-tail-placeholder.png     |
| `merchants-stained-charm` | merchants-stained-charm-placeholder.png |
| `floor-key-bronze`        | floor-key-bronze-placeholder.png        |
| `floor-key-silver`        | floor-key-silver-placeholder.png        |
| `floor-key-gold`          | floor-key-gold-placeholder.png          |
| `floor-key-void`          | floor-key-void-placeholder.png          |
| `health-vial`             | health-vial-placeholder.png             |
| `lucky-charm`             | lucky-charm-placeholder.png             |

Each manifest entry uses `sourceRun: "placeholder"` so the generator can
identify and replace them later.

## How InventoryUI Picks These Up

`InventoryUI` already calls `getGeneratedRegistry().lookup(def.id)`. The new
manifest entries use `briefId == item id` (e.g. `"iron-ore"`), so the lookup
finds them immediately — no engine changes needed.

## What's Next

Run the real AI generation pipeline when API access is available:

```bash
npm run sprites:batch -- --briefs-dir briefs/items
# Review then approve winners
npm run sprites:approve -- generated/runs/<name>/<run-id> --variant <n>
```

The `--force` flag on `gen-placeholders` will NOT be needed once real sprites
are approved — the generator already skips any entry with a non-placeholder
`sourceRun`.

## Apples

**Estimate:** 🍎🍎
**Actual:** 🍎🍎 — Script + palette + 13 pixel designs + manifest wiring. Accurate.
**Verdict:** On target.
