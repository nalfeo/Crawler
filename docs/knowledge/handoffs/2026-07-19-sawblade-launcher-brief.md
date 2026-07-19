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

Eight variations cover different feed mechanism designs (side-stack magazine,
spring-loaded coil, drum magazine, split twin-barrel, chain-fed, cage muzzle,
crank-handle, bullpup layout).

## Verification

- `npm run verify:fast` passed (1295 tests, 89 test files) — no regressions.

## Blocker: sprite generation requires maintainer action

Issue #1333 needs the `asset-request` label to trigger the generation workflow.

### Required next step (maintainer action)

```
gh issue edit 1333 --add-label asset-request --repo nalfeo/Crawler
```

Once labeled, the `asset-request.yml` workflow will:

1. Ingest issue #1333 and synthesize a brief (the authored `briefs/weapons/sawblade-launcher.yaml` will be preferred if discovered)
2. Generate 16 variants via Azure OpenAI / GPT-Image-1
3. Run deterministic sensors + VLM judge
4. Post results back to the issue

## Follow-up / Blockers

- Maintainer must add `asset-request` label to issue #1333 to trigger generation
- After generation, maintainer reviews variants and approves with `sprites:approve`
- Approved art goes through normal `sprites:checkin` → `sprites:asset-pr` → wiring pipeline
