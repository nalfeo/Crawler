# Session Handoff: snailfolk-sludge-artillery asset brief

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 — brief authoring only, no runtime code changes. Tooling-only ceremony cap applies. Art-only diff; review-ledger-exempt.

## What Was Done

Authored `briefs/enemies/snailfolk-sludge-artillery.yaml` for issue #2572.

This brief creates a Floor 2 snailfolk artillery enemy — a snailfolk soldier carrying a
backpack-mounted sludge cannon. The brief is ready for generation once the Azure sidecar
credentials are available in the environment.

### Brief design decisions

- `type: enemy`, `floor: 2`, `sizeVariant: default` — standard 64×64 hostile sprite, Floor 2 difficulty tier.
- Front-facing sensor override (`sensors.enemy.facing: front`, `toleranceDeg: 25`) — the brief
  explicitly calls for a front-facing artillery posture; matches snailfolk-boss and imp-chain-brawler patterns.
- `edge.allowMainTouch: true` — the backpack tank and cannon nozzle will fill a wide upper silhouette; the
  main body touching the frame edge is expected for a heavily-equipped soldier.
- Description centers the read on the **sludge cannon as visual centerpiece**, with the backpack tank, rubber
  hoses, nozzle, and acid-green slime drip as the dominant visual mass. The snailfolk body (dark olive/slate-blue)
  is grounded below it.
- Earth-tone snailfolk palette (dark olive body, slate-blue soft torso, charcoal shell, iron-grey fittings,
  verdigris rubber) anchored from `snailfolk-boss.yaml`. The only bright accent is the toxic acid-green slime
  — explicitly called out as exclusive to slime material to prevent the model from borrowing it for the face/body.
- Three variation seeds: (1) cannon nozzle + slime drip read, (2) tank backpack + hose silhouette, (3) overall
  cannon-as-centerpiece composition. Each explores the dominant element from a different visual angle.
- `judge.enabled: true`, `minVariations: 3`, `maxVariants: 4` — enables unattended quality filter; enough
  candidate pressure without a huge burn.

## Generation attempt

- `npm run sprites:run -- --brief briefs/enemies/snailfolk-sludge-artillery.yaml` was attempted.
- **Azure credentials unavailable** (`AZURE_OPENAI_ENDPOINT` is not set in this environment). This is expected
  per the "Azure-required sidecar policy" (AGENTS.md). Generation blocked at the credential check, not a
  pipeline error.
- `node_modules` is also not installed in this runner environment.
- The brief is committed and ready; the next developer session with Azure credentials can run the pipeline
  directly against the committed brief.

## GitHub issue plan comment

- `gh issue comment 2572` returned **HTTP 403** — this runner does not have write-access to the repo's
  issue tracker. The full plan (high-level approach, key decisions, concrete checklist) is recorded in the
  PR description instead. The intended comment text is preserved in this handoff below for auditability.

### Intended plan comment text (blocked by 403)

```
## Plan: snailfolk-sludge-artillery asset brief

**Mode:** local (bounded single-enemy scope)
**Apple estimate:** 1🍎 (brief authoring only; art-only diff, ledger-exempt)

**Key decisions:**
- Snailfolk family palette (earth-tone body from snailfolk-boss.yaml): dark olive/slate-blue body, charcoal shell, iron-grey fittings
- Acid-green slime as the sole bright accent — explicitly bound to slime material only
- Front-facing artillery braced stance; cannon + backpack tank as dominant silhouette mass
- 3 variation seeds each exploring the cannon centerpiece from a different angle
- judge.enabled: true, minVariations: 3

**Checklist:**
- [x] Read references (sprite-style.md, snailfolk-boss.yaml, imp-chain-brawler.yaml, enemy template)
- [x] Author briefs/enemies/snailfolk-sludge-artillery.yaml
- [ ] Generate with npm run sprites:run (blocked: Azure credentials not available in this environment)
- [x] Commit brief
- [x] Create handoff
- [x] Open PR closing #2572
```

## What Needs to Happen Next

1. **Generate:** In an environment with `AZURE_OPENAI_ENDPOINT` set (or via the `asset-request.yml`
   workflow), run:
   ```
   npm run sprites:run -- --brief briefs/enemies/snailfolk-sludge-artillery.yaml
   ```
2. **Judge:** Use the `sprite-judge` skill to review the generated variants. Pay special attention to:
   - The acid-green slime accent not bleeding onto the body/face materials.
   - The cannon+tank assembly reading as the dominant silhouette element.
   - The snailfolk shell visible behind/below the backpack.
3. **Approve + check-in:** `npm run sprites:approve -- <runDir> --variant <N>`, then `npm run sprites:checkin`.
4. **Batch art PR:** `npm run sprites:asset-pr` to fold the check-in into the art-only PR queue.
5. **Wire:** After art merges, check `src/shared/generated-assets.ts` and `entity-sprite-mappings.json`
   to wire `snailfolk-sludge-artillery` to the approved generated sprite (replacing any placeholder).
6. **Observe:** Confirm rendering in `npm run dev` or the headless probe before closing the art loop.
