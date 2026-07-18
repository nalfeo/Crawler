---
date: 2026-07-18
session: copilot/create-stone-maul-icon
apple_estimate: 1
---

# Handoff: stone-maul sprite asset (issue #1306)

**Date:** 2026-07-18
**Branch:** `copilot/create-stone-maul-icon`
**Apple estimate:** 1🍎 (pure art pipeline, review-ledger-exempt)

## Systems touched

sprite-workflow

## Summary

Authored the `briefs/weapons/stone-maul.yaml` brief for the Floor 2 bludgeon
weapon icon (`equipment/weapon/stone-maul`, stable ID `weapon.stone-maul`).
Brief describes a massive granite war maul: large rough stone head dominating
the upper half of the frame, vertical orientation, worn hardwood haft, dark
earthy tones with a grungy dungeon look.

Posted the plan comment on issue #1306 (via `engine-tools-reply_to_comment`).

## What was completed

- [x] `briefs/weapons/stone-maul.yaml` authored and committed
- [x] Plan comment posted on issue #1306
- [x] `npm run verify:fast` → ✅ passed (87 test files, 1260 tests)

## What is blocked / remaining

Generation (`npm run sprites:run`) requires `AZURE_OPENAI_ENDPOINT` which is
**intentionally not available** in the Copilot coding agent session per the
project's security policy (copilot-setup-steps.yml does not include Azure
credentials to prevent exfiltration).

**Remaining pipeline steps (require maintainer action to unblock):**

1. **Add `asset-request` label to issue #1306** → triggers `asset-request.yml`
   CI workflow which has the Azure credentials and will:
   - Synthesize/generate the 4×4 sprite sheet via Azure OpenAI
   - Judge all 16 variants (deterministic sensors + VLM judge ≥3 bar)
   - Approve the best passing variant
   - Check it in to an `asset-checkin` branch
   - Post a completion comment on the issue

2. **Batch art PR** (`npm run sprites:asset-pr`) → consolidates the checkin
   branch into one art-only PR that closes issue #1306.

3. **Wire** → after art lands, a separate code PR maps runtime key
   `equipment/weapon/stone-maul` to the approved sprite entry.

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

## Unresolved issues

- Issue #1306 missing `asset-request` label → maintainer must add it
- Azure credentials unavailable in Copilot agent session (by design)
- Generation, approval, check-in, and PR batch remain to be executed by
  the CI pipeline once the label is added

## Recovery instructions

If the label is added and CI still doesn't pick it up:

```bash
# Manual workflow dispatch (requires gh auth with actions:write scope):
gh workflow run asset-request.yml --repo nalfeo/Crawler

# Or trigger by editing the issue body (which fires the 'edited' event)
```
