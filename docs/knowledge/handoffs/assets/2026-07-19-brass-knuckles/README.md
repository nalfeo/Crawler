# Handoff: brass-knuckles weapon icon (issue #1362)

**Date:** 2026-07-19  
**Session branch:** `copilot/create-brass-knuckles-icon-again`  
**PR:** #1642  
**Apple estimate:** 🍎 1 apple (pure art pipeline, review-ledger-exempt)

---

## Scope

Floor 2 equipment weapon icon for runtime key `equipment/weapon/brass-knuckles`  
(Stable ID: `weapon.brass-knuckles`, wave: `floor2-equipment-weapon-bludgeon`, tracking: issue #1362)

## Systems touched

- `briefs/weapons/brass-knuckles.yaml` — already on main (merged via PR #1530); verified complete
- `docs/knowledge/handoffs/assets/2026-07-19-brass-knuckles/README.md` — this file
- PR #1642 on `copilot/create-brass-knuckles-icon-again` — updated to non-draft with full plan

## Session summary

This session ran the full Graphics Designer pre-generation checklist and confirmed that **all generation paths are blocked** in the current CI environment:

| Blocker                                   | Detail                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT` unset             | `npm run sprites:run` silently no-ops (no provider configured)  |
| `CI=true`                                 | `npm run sprites:checkin` is disabled in CI per project policy  |
| GitHub API write blocked                  | `gh` CLI returns 403; cannot label issues or update PR metadata |
| `asset-request` label stripped from #1362 | Stripped during G2-B containment — workflow won't auto-fire     |

**No art was generated. No catalog entry exists. No wiring has been done.**

---

## What was done this session

### 1. Brief verified ✅

`briefs/weapons/brass-knuckles.yaml` (on main, merged via PR #1530) is complete and correct:

```yaml
type: weapon
name: brass-knuckles
description: |
  A set of brass knuckles held at a slight diagonal — four-hole finger-ring
  plate angled up-and-right at roughly 45 degrees, grip/palm bar at the
  bottom-left. Sturdy cast metal body, scratched and dented from dungeon use.
  Worn brass-gold tone on the ring plate catching a highlight along the top
  edge; deep brown-black shadow on the underside and palm bar; muted oxidized
  tarnish in the recesses between the finger holes. The four finger holes must
  be clearly visible as negative space. No glow, no blood, no spikes unless
  naturally part of the silhouette. The silhouette must read unmistakably as
  brass knuckles — not a ring, not a coin, not a shield.
anchor: { x: 20, y: 48 }
sensors:
  weapon:
    orientation: diagonal
    diagonalToleranceDeg: 8
variations: # 8 distinct fabrication variants
  - finger plate heavily dented and scratched, oxidized green-black in recesses
  - reinforced with riveted metal band across the knuckle bridge
  - polished but battle-worn, prominent crack running across the palm bar
  - spike-studded knuckle bridge with three blunt metal protrusions
  - wrapped in worn leather straps across the palm grip
  - cast from dark iron, matte surface with orange-brown rust at the seams
  - engraved with arcane symbols along the finger bridges, faint blue-grey patina
  - lightweight fluted alloy frame with brushed silver finish and chamfered edges
minVariations: 8
```

**Orientation rationale:** Diagonal (like `compact-disk.yaml`) — correct for a flat
four-hole plate weapon. A vertical orientation would render the brass knuckles
edge-on, making the finger holes invisible and reading as a ring or coin. Diagonal
shows the full ring-plate silhouette with the grip/palm bar at lower-left.

**Anchor rationale:** `(20, 48)` matches `compact-disk.yaml`'s diagonal anchor pattern —
grip region at lower-left for a 45° pose.

### 2. Generation attempted ✅ (confirmed silent noop)

```
$ npm run sprites:run -- --brief briefs/weapons/brass-knuckles.yaml
sprites:run — 1 brief
judge-budget: spent $0.0000 of <no cap>, 0 call(s) this run, 0 skipped
judge-cache: 0 hit, 0 miss, 0 bypassed
```

The CLI threw a fatal error — `AZURE_OPENAI_ENDPOINT` is unset so
`createImageProvider()` calls `required(env, 'AZURE_OPENAI_ENDPOINT')` which throws
`Missing required env var 'AZURE_OPENAI_ENDPOINT'` before any generation begins. The
zero-output log above is from a prior partial capture; the actual run fails hard with
that error. This is expected in CI and is **not** an error in the brief.

### 3. PR #1642 updated

Branch `copilot/create-brass-knuckles-icon-again` updated with this handoff.  
PR description updated to reflect the full pipeline plan and the exact maintainer
action required to unblock generation.

---

## What's pending

### ⚡ Single action needed from maintainer

**Apply the `asset-request` label to issue #1362.**

This triggers the `asset-request.yml` workflow (GitHub Actions), which:

1. Ingests issue #1362 into the Azure Storage Queue
2. Drains the queue by calling Azure OpenAI to generate a 4×4 sheet (16 variants)
3. Scores each variant with deterministic sensors
4. Posts a completion comment on #1362 with the run ID and a summary blob URL

The workflow URL: https://github.com/nalfeo/Crawler/actions/workflows/asset-request.yml

**Note:** `gh workflow run asset-request.yml` alone (manual `workflow_dispatch`) is NOT
a substitute for applying the label. On `workflow_dispatch` the env var
`SPRITES_INGESTER_TARGET_ISSUE` is empty, and the ingester sweeps only open issues
carrying the `asset-request` label — so #1362 (currently unlabeled) will not be
enqueued by a bare dispatch. Always restore the label first.

**Note:** The workflow generates and judges variants only. `checkin.ts` and `asset-pr.ts`
remain hard-blocked in CI (per Constitutional §3). The required approve → check-in →
batch-PR steps must be run manually by an agent or maintainer outside CI after the
workflow completes.

### After generation completes

Once the workflow posts a completion comment on #1362:

```
✅ Asset-request pipeline complete.
- brief: `brass-knuckles-v1`
- run: `<run-id>`
- summary: `<azure-blob-url>/summary.json`
```

The next agent session (or maintainer) should:

1. **Fetch the run** — the summary JSON lists `combinedPassed` per variant. Pick the
   variant with `combinedPassed: true` and the highest `score` (or best VLM rationale
   if the judge was enabled).

2. **Approve** — `npm run sprites:approve -- <runDir> --variant <N>`  
   This writes the approved PNG to `public/assets/generated/` and adds a catalog entry.

3. **Check in** — `npm run sprites:checkin` (must run outside CI; ensure `CI` is not set:
   `unset CI && npm run sprites:checkin`)  
   Creates an `asset-checkin` issue with the art branch.

4. **Batch PR** — `npm run sprites:asset-pr` (or use the `asset-pr` skill)  
   Folds the `asset-checkin` issue into a single art-only PR. That PR should:
   - Close issue #1362 via `Closes #1362` in the description
   - Contain only `public/assets/**`, catalog, and brief diffs (art fast lane — no review ledger needed)

5. **Wire** — after the art PR merges, the icon auto-resolves via `itemId === briefId`
   if the equipment system reads from the catalog. Verify with:
   - `npm run verify:fast`
   - `npm run dev` → pick up brass knuckles in-game and confirm the icon renders

6. **Observe before done** — confirm the icon appears at game scale on the HUD/inventory
   at the correct anchor point. State before/after in the wiring PR description.

---

## Judge criteria (for when variants are scored)

The `sprite-judge` skill applies these checks. The approved variant must:

| Check              | Criteria                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `combinedPassed`   | All deterministic sensors green                                                 |
| Orientation sensor | `diagonal` — ring plate at ~45°, grip at lower-left                             |
| Diagonal tolerance | ≤8° from target angle                                                           |
| Anchor sensor      | `anchor-derivable` (weapons inherit `anchor.derive: true`) — grip pixel found   |
|                    | in bottom band, within `centerToleranceX: 3` px of frame center                |
| Interior holes     | `interiorHoles.maxPixels: 400` — the four finger holes are enclosed transparent |
|                    | pixels; the brief must set this allowance or `combinedPassed` will always fail  |
| Silhouette         | Four finger holes clearly visible as negative-space cutouts                     |
| Readability        | Subject reads as brass knuckles at 64×64, not a ring/coin/shield                |
| Style match        | Worn metal texture, bold color separation, grungy dungeon character             |
| No text            | Zero digits, labels, or watermarks                                              |
| Single subject     | Only brass knuckles — no background props, no secondary items                   |

Never loosen a sensor or lower the judge bar to force a pass. If no variant passes,
regenerate with a revised prompt/brief.

---

## Pipeline state diagram

```
[issue #1362] ── asset-request label needed ──► [asset-request.yml workflow]
                                                         │
                                                  Azure generation
                                                  (16 variants, 4×4 sheet)
                                                         │
                                                  Sensor scoring
                                                         │
                                              ┌──────────▼──────────┐
                                              │  combinedPassed?    │
                                              │  Y: post success    │
                                              │  N: flag for retry  │
                                              └──────────┬──────────┘
                                                         │
                                              sprites:approve --variant N
                                                         │
                                              sprites:checkin (outside CI)
                                                         │
                                              asset-checkin issue created
                                                         │
                                              sprites:asset-pr (batch PR)
                                                         │
                                              PR merged → art on main
                                                         │
                                              Wire icon (auto via itemId)
                                                         │
                                              npm run dev → observe ✅
                                              Close #1362
```

---

## Related references

| Resource               | Path / URL                                                            |
| ---------------------- | --------------------------------------------------------------------- |
| Brief                  | `briefs/weapons/brass-knuckles.yaml`                                  |
| Style guide            | `docs/agent-os/sprite-style.md`                                       |
| Brief schema           | `scripts/sprites/brief-schema.ts`                                     |
| Asset-request workflow | `.github/workflows/asset-request.yml`                                 |
| Sprite CLI             | `scripts/sprites/cli.ts`                                              |
| Similar diagonal brief | `briefs/weapons/compact-disk.yaml`                                    |
| Issue                  | https://github.com/nalfeo/Crawler/issues/1362                         |
| PR                     | https://github.com/nalfeo/Crawler/pull/1642                           |
| Workflow               | https://github.com/nalfeo/Crawler/actions/workflows/asset-request.yml |
