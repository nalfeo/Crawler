# Handoff: shock-baton sprite pipeline (generation + wiring)

**Date:** 2026-07-19  
**Agent:** Graphics Designer (Asset Forge)  
**Apple estimate:** 1🍎 (pure art pipeline — brief exists, zero-code wiring path confirmed)  
**Issue:** #1348 (Asset request: shock-baton)  
**Aggregate tracking:** #1303  
**Prior handoff:** `docs/knowledge/handoffs/2026-07-18-shock-baton-brief.md`

---

## Summary

Second session for the shock-baton asset pipeline. The brief was authored in the previous session
(`briefs/weapons/shock-baton.yaml`). This session completed:

- ✅ Preflight / persona loaded (Graphics Designer)
- ✅ Style guide reviewed (`docs/agent-os/sprite-style.md`)
- ✅ Brief verified correct — inherits `weapon.json` defaults (64×64, vertical orientation, VLM judge enabled)
- ✅ Pipeline architecture fully investigated
- ✅ Wiring path confirmed: **zero-code**, auto-resolves via `resolveItemSprite('shock-baton', ...)` at `TIER_BARE_REAL` once approved
- ✅ Placeholder audit run — shock-baton confirmed at 0 real art (still in the 152-placeholder pool)
- ✅ Investigated all 558 GitHub Actions `asset-request.yml` workflow runs to find root cause of missing generation
- ✅ Handoff written

**Blocked on:** Azure sprite generation (requires maintainer to trigger `workflow_dispatch`).

---

## Why generation hasn't happened (root cause)

The G2-B seed wave opened all 70 Floor-2 equipment issues nearly simultaneously
(2026-07-18T01:25–01:27Z). GitHub's queue can only hold one pending run per concurrency group
(`asset-request-worker`). All 70+ triggered runs were **cancelled before any job started** (0 jobs,
3-second window). Run 29625171107 was shock-baton's specific cancelled run.

Since then, all `asset-request.yml` workflow events have been for unrelated non-asset-request
issues (CI recovery events) — all `skipped`. The Azure queue has not been replenished.

---

## Brief status

`briefs/weapons/shock-baton.yaml` — **correct and ready to generate:**

```yaml
type: weapon # inherits weapon.json defaults
name: shock-baton # = itemId = manifest briefId (bare, TIER_BARE_REAL auto-resolution)
description: |
  A compact one-handed shock baton held perfectly vertical and centered...
  Floor 2 palette: dark graphite, muted steel accents, restrained electric-cyan glow at emitter tip.
variations:
  - baton body with segmented insulated rings along the shaft
  - dual-prong emitter tip instead of a capped single-head tip
minVariations: 6
```

Inherited from `data/sprite-types/weapon.json`:

- Size: 64×64 px
- Anchor: x=32 y=56 (bottom-center grip, derived by sensor)
- Sheet: 4×4 grid, 16 variants per run
- Sensors: `weapon.orientation=vertical`, `anchor.derive=true`
- Judge: `enabled=true` (runs locally, not in CI), `maxVariants=16`

---

## Wiring analysis

**Wiring path: zero-code (auto-resolution via item-sprites.ts)**

When `npm run sprites:approve` runs with brief `shock-baton`, the manifest entry will have:

- `briefId: 'shock-baton'` (bare, since `shock-baton` is in `itemArtIdentitySet`)
- `assetPath: 'generated/shock-baton-var-N.png'`

`resolveItemSprite('shock-baton', registry, seed)` in `src/shared/item-sprites.ts` will:

1. Find manifest entry where `briefId === 'shock-baton'` → `matchConcept` returns `{ bare: true }`
2. Score as `TIER_BARE_REAL` (lowest tier = highest priority)
3. Return it over any placeholder at `TIER_PLACEHOLDER`

**No code changes needed** for wiring. `sprites:generate-wiring` would produce an empty diff
(no patches needed since the item-sprites.ts resolution is already in place).

Runtime key `equipment/weapon/shock-baton` is defined in `floor2-equipment-art.ts` line 59+165.
The stable ID `weapon.shock-baton` maps to runtime key via `runtimeKeyForFloor2Equipment`.

---

## Environment blockers (both sessions)

Both this session (2026-07-19) and the previous session (2026-07-18) hit the same hard blocks:

| Blocker                                  | Reason                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot post GitHub issue comments        | DNS monitoring proxy blocks all GitHub REST/GraphQL API calls from this environment                                                    |
| Cannot trigger `workflow_dispatch`       | Same DNS proxy block; `gh` CLI also has an invalid token (`ghu_*` user access token)                                                   |
| Cannot run `npm run sprites:run` locally | `isCloudEnv()` returns true (CI=true, GITHUB_ACTIONS=true) → env-bootstrap refuses to write `.env.local` → no Azure OpenAI credentials |

The plan comment required by the maintainer could not be posted. The plan is documented in this
handoff and was delivered in the session response.

---

## Unblock steps (maintainer action required)

**One-time action needed — just trigger the workflow:**

**Option A (browser):**
Go to https://github.com/nalfeo/Crawler/actions/workflows/asset-request.yml → **Run workflow** →
**Run workflow** (defaults are fine — the ingest sweep will pick up issue #1348 which is already
open and labeled `asset-request`).

**Option B (terminal):**

```bash
gh workflow run asset-request.yml --repo nalfeo/Crawler
```

**Option C (re-label the issue to fire a `labeled` event):**

```bash
gh issue edit 1348 --remove-label asset-request --repo nalfeo/Crawler
gh issue edit 1348 --add-label asset-request --repo nalfeo/Crawler
```

---

## Post-trigger pipeline (no further human action needed)

Once the workflow fires, the pipeline proceeds unattended:

```
asset-request.yml runs
  → ingest-once: enqueues issue #1348 into Azure queue
  → worker: generates 16-variant sheet via Azure OpenAI gpt-image-1
             judges each variant (sensors + VLM, locally)
             uploads run artifacts to Azure blob storage
  → worker exits with success or posts failure comment on #1348
```

Then either:

- **Auto-path (g2b-harvest-approve.yml):** The G2-B harvest workflow can be triggered to
  download the Azure blob run, approve the best `combinedPassed` variant, and open the art PR:
  ```bash
  gh workflow run g2b-harvest-approve.yml --repo nalfeo/Crawler \
    --field dry_run=false --field create_pr=true
  ```
- **Manual path (from any machine with Azure creds):**
  ```bash
  npm run sprites:approve -- generated/runs/shock-baton/<run-id> --variant N
  npm run sprites:checkin
  npm run sprites:asset-pr   # opens art-only PR closing #1348
  ```

---

## Observe before done (to complete after art lands)

After the art PR merges:

1. **Wiring verification:** Run `npm run sprites:generate-wiring -- --since main --output summary`.
   Expect empty output (zero-code path; no patches needed).

2. **Runtime observation:** In `npm run dev` or `npm run lab -- sprite-gallery`, equip shock-baton
   in the inventory UI. Confirm the slot renders the approved `shock-baton-var-N.png` sprite
   (not the placeholder). Capture before/after screenshots.

3. **Headless probe:** `npm run verify:fast` should pass with the new manifest entry. No new
   sensor entries needed (manifest entry created by `approve.ts` includes the sensor results).

---

## Systems touched

- `briefs/weapons/shock-baton.yaml` (read-only this session)
- `docs/knowledge/handoffs/2026-07-19-shock-baton-sprite.md` (this file)

**When art lands (post-trigger):**

- `public/assets/generated/shock-baton-var-N.png`
- `public/assets/generated/manifest.json` (approve step)
- `src/shared/data/sprite-catalog.json` (checkin step)
- Art-only PR branch (checkin step)
- No engine/game code changes (zero-code wiring path)

---

## Apple estimate rationale

**1🍎** — Pure art pipeline. Brief exists, wiring is zero-code (no engine/game changes). Art-only
PR is review-ledger-exempt (only `public/assets/**`, catalog, briefs touched). The only blocker is
the Azure generation step which requires a maintainer workflow dispatch.
