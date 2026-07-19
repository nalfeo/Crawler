# Handoff: sawblade-launcher Floor 2 Equipment Icon Brief

**Date:** 2026-07-19
**Session slug:** sawblade-launcher-brief
**Apple estimate:** 🍎 (1 apple — sprite brief only)
**Persona:** Graphics Designer

## Systems touched

sprite-pipeline

## What was done

### Brief authored

Created `briefs/weapons/sawblade-launcher.yaml` — a weapon brief for the
Floor 2 sawblade-launcher equipment icon. The brief inherits all defaults from
`data/sprite-types/weapon.json` (64×64, kenney-roguelike palette, vertical
orientation, anchor 32,56, 4×4 sheet, VLM judge enabled).

The description specifies:

- A hand-held iron launcher tube held vertically (grip/trigger at bottom, barrel pointing up)
- Large serrated disc sawblade visibly slotted at the muzzle, teeth fanning outward
- Boxy side-mounted disc magazine housing stacked blades, bolt-fastened to mid-frame
- Floor 2 worn cast-iron tone: dark gunmetal, rust patches, hex-bolt detailing
- 3–4 shadow stops for interior shading; single bright edge highlight
- No glow, no sparks, no background

Eight variations are secondary embellishments (cage, viewing window, charging handle,
wrist strap, bolt rows, iron sight, rust pattern, blade-guide rail). All keep the
single vertical barrel, side-mounted magazine, bottom grip, and muzzle sawblade
intact — per the constraint that variations must not replace defining geometry.

## Verification

- `npm run verify:fast` passed (1295 tests, 89 test files) — no regressions.

## Sprite generation: use sprites:run directly

**Important:** Do NOT add the `asset-request` label to issue #1333 to trigger
generation — the issue pipeline (`runIssuePipeline`) unconditionally synthesizes
its own brief from the issue body and ignores already-checked-in briefs. Issue
#1333 also has no Floor field, so the pipeline would default to Floor 1 rather
than Floor 2.

### Required next step (maintainer action)

Generate directly from the checked-in brief:

```
npm run sprites:run -- --brief briefs/weapons/sawblade-launcher.yaml
```

This uses Azure OpenAI / GPT-Image-1, runs deterministic sensors + VLM judge,
and writes output to `files/sprites/weapons/sawblade-launcher/`.

## Follow-up / Blockers

- Run `npm run sprites:run -- --brief briefs/weapons/sawblade-launcher.yaml` to generate
- After generation, review variants and approve with `npm run sprites:approve`
- Approved art goes through normal `sprites:checkin` → `sprites:asset-pr` → wiring pipeline
