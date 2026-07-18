---
date: 2026-07-18
session: copilot/asset-request-stone-maul
apple_estimate: 1
---

# Handoff: stone-maul sprite asset (issue #1431)

**Date:** 2026-07-18
**Branch:** `copilot/asset-request-stone-maul`
**Apple estimate:** 1🍎 (pure art pipeline, review-ledger-exempt)

## Systems touched

sprite-workflow

## Summary

Authored the `briefs/weapons/stone-maul.yaml` brief for the Floor 2 bludgeon
weapon icon (`equipment/weapon/stone-maul`, stable ID `weapon.stone-maul`).
Brief describes a massive granite war maul: large rough stone head dominating
the upper half of the frame, vertical orientation, worn hardwood haft, dark
earthy tones with a grungy dungeon look, while preserving the runtime key
exactly via the brief id `stone-maul`.

Posted the required pre-code plan reply on issue #1431 via
`engine-tools-reply_to_comment`.

## What was completed

- [x] `briefs/weapons/stone-maul.yaml` authored and committed
- [x] Plan comment posted on issue #1431
- [x] `git fetch --unshallow origin && git fetch origin main:refs/remotes/origin/main`
- [ ] `npm run verify:fast` after the brief/handoff changes

## What is blocked / remaining

The canonical asset-request workflow for issue #1431 is already queued
(`Asset Request Pipeline` run `29625257880`), so the remaining work is waiting
for that normal Azure-backed generation / judge / check-in path to finish or
fail loudly.

**Remaining pipeline steps (canonical workflow path):**

1. **Issue workflow completes** (`asset-request.yml`) and:
   - Synthesize/generate the 4×4 sprite sheet via Azure OpenAI
   - Judge all 16 variants (deterministic sensors + VLM judge ≥3 bar)
   - Approve the best passing variant
   - Check it in to an `asset-checkin` branch
   - Post a completion comment on the issue

2. **Batch art PR** (`npm run sprites:asset-pr`) → consolidates the checkin
   branch into one art-only PR that closes issue #1431.

3. **Wire** → after art lands, a separate code PR maps runtime key
   `equipment/weapon/stone-maul` to the approved sprite entry, but only if the
   placeholder audit shows an explicit runtime replacement is still needed.

## Brief quality notes

The brief follows the skull-mace pattern (vertical orientation, all defaults
inherited from `data/sprite-types/weapon.json`) with these specifics:

- **Stone maul identity:** large rough-hewn granite boulder head at top,
  thick hardwood/bone haft with wrapped grip and iron ferrule below
- **Silhouette first:** "giant rock on a stick" must read at 64×64
- **No magic:** no glow, no runes, no enchantment — pure primitive weapon
- **Floor 2 tone:** Floor 2 styling (grungy, worn, dangerous-looking)
- **Sensor tweak:** `anchor.centerToleranceX: 5` (vs default 3) to allow
  the asymmetric stone mass to pass the anchor sensor without false failures
- **2 variation seeds + minVariations: 8** for sheet diversity

## Files touched

- `briefs/weapons/stone-maul.yaml` — new brief for stone-maul weapon icon
- `docs/knowledge/handoffs/2026-07-18-stone-maul.md` — this session handoff

## Unresolved issues

- Awaiting the queued issue workflow run `29625257880` to either produce an
  approved check-in branch or report a pipeline failure
- No generated PNG / manifest / catalog changes landed on this branch yet; this
  session only commits the source brief + handoff

## Recovery instructions

If run `29625257880` fails or ends without a terminal completion comment:

```bash
# Re-run the canonical issue workflow (requires GitHub auth with actions:write):
gh workflow run asset-request.yml --repo nalfeo/Crawler

# Or edit the issue body/comment to trigger the issue workflow again.
```
