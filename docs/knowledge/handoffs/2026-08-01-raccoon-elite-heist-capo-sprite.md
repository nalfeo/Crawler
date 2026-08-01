# Handoff: raccoon-elite-heist-capo sprite (2026-08-01)

**Persona**: Graphics Designer  
**Apple estimate**: 1🍎 (art-only brief + generate + wire; wiring is a 1-line config change — no review ledger required)  
**Mode**: issue-wave (local unavailable — node_modules empty, external network blocked)  
**PR**: #2582 "[WIP] Add asset for raccoon elite heist capo"  
**Branch**: `copilot/asset-request-raccoon-elite-heist-capo`

---

## Summary

End-to-end sprite pipeline for the `raccoon-elite-heist-capo` enemy (Floor 2, raccoon family). Brief authored, generated via CI issue-wave, approved, checked in, and wired into `generated-assets.ts`.

---

## Systems touched

| System | Change | Reason |
|--------|--------|--------|
| `briefs/enemies/raccoon-elite-heist-capo.yaml` | New brief | Detailed brief with palette ramps, 4 variations, sensor overrides (front-facing, toleranceDeg 25) |
| `public/assets/generated/raccoon-elite-heist-capo-v1-var-9.png` | New art asset | Approved sprite (90KB, 256×256, 7/7 sensors) |
| `public/assets/generated/entries/raccoon-elite-heist-capo-v1-var-9.json` | New entry JSON | Manifest entry with anchor, sensor breakdown, judge scorecard |
| `src/shared/generated-assets.ts` | Line 644 | Wired `raccoon-elite-heist-capo` → `raccoon-elite-heist-capo-v1` (was `raccoon-thief`) |

---

## Pipeline execution

### Generation
- **Mode**: issue-wave (CI)
- **Issue**: #2566 "Asset request: raccoon-elite-heist-capo"
- **Workflow run**: 30686146471 (Asset Request Pipeline, run #924, success)
- **Brief synthesized as**: `raccoon-elite-heist-capo-v1` (CI adds `-v1` suffix during synthesis — see known issues)
- **Run ID**: `2026-08-01T05-53-10-9e2487cb`
- **Sheet**: 4×4 grid, 16 variants generated

### Judge results (selected variants — all 0 sensor failures)
| Variant | Sensors | Judge | Brief match | Readability | Pose | Figure |
|---------|---------|-------|-------------|-------------|------|--------|
| var-9 (10/16) ✅ chosen | 7/7 | 4 | 5 | 4 | 5 | 5 |
| var-8 (9/16) | 7/7 | — | — | — | — | — |
| var-3 (4/16) | 7/7 | — | — | — | — | — |

**Chosen**: var-9 — top-ranked by CI selection (listed first among selected variants).

**VLM judge rationale (var-9)**:
- `briefMatch: 5` — "unambiguously depicts the described raccoon elite heist capo, including the tailored turtleneck, beret, blueprint tube, and silver watch. The swagger and sharp shoulders are also evident."
- `figureFraming: 5` — "Entire figure fully framed, all parts visible and well-proportioned."
- `poseOrientation: 5` — "Oriented at a one-third turn, face and body clearly visible."
- `readability: 4` — "Silhouette clear, key elements visible. Dark clothing palette slightly blends into dark floor tiles." (acceptable, not a failure)
- `confidence: 0.92`

### Layer-3 eyeball check
⚠️ **Blocked in this session**: Azure Blob Storage (`crawlersprites.blob.core.windows.net`) and GitHub are network-blocked from the CI agent environment. The PNG could not be fetched for visual inspection.  
The maintainer (nalfeo) should view the sprite sheet on the GitHub issue before merging: https://github.com/nalfeo/Crawler/issues/2566#issuecomment-5150083087

---

## Wiring

The `generatedBriefIdForEnemy` function first checks `registry.variants(appearanceKey)` directly, then falls back to `GENERATED_BRIEF_BY_APPEARANCE_KEY`. Since the CI synthesized the brief as `raccoon-elite-heist-capo-v1` (not the bare `raccoon-elite-heist-capo`), the explicit fallback map was updated:

```typescript
// before:
'raccoon-elite-heist-capo': 'raccoon-thief',
// after:
'raccoon-elite-heist-capo': 'raccoon-elite-heist-capo-v1',
```

This is a working wire. If a future run generates a brief with the bare ID `raccoon-elite-heist-capo`, the auto-resolution path will take over and the map entry becomes a belt-and-suspenders fallback.

---

## Observe before done

⚠️ **Blocked in this session**: `npm run dev` and headless probes cannot run without `node_modules` (npm install failed — network blocked). The CI pipeline will run `verify:fast` and type-check on PR #2582.

**Before/after**:
- Before: `raccoon-elite-heist-capo` rendered using `raccoon-thief-var-0.png` placeholder
- After: `raccoon-elite-heist-capo` renders `raccoon-elite-heist-capo-v1-var-9.png` (elite capo with turtleneck, beret, blueprint tube)

Confirming rendering in the live game is deferred to the maintainer at merge time. The sprite loads via the standard `generatedAssets` texture registry (no engine changes required).

---

## Known issues / follow-up

1. **`-v1` suffix orphan**: CI brief synthesis appended `-v1` to the brief name. The sprite-judge skill warns this is the "name-variance orphan class." The explicit appearance key map handles this correctly today, but if future runs generate a bare-id `raccoon-elite-heist-capo` brief, the map entry should be updated to `'raccoon-elite-heist-capo': 'raccoon-elite-heist-capo'` for the cleaner auto-resolve path.

2. **Other two variants available**: var-3 and var-8 are also published in `assets/queue` (0 sensor failures each). The maintainer may approve additional variants if desired.

3. **`raccoon-bottle-rocketeer` still a placeholder** (`'raccoon-bottle-rocketeer': 'raccoon-thief'`). Issue for this is separate.

---

## Remaining placeholder count (raccoon family)

| Entity | Status |
|--------|--------|
| `raccoon-boss` | ✅ Real art (`raccoons-boss-var-0.png`) |
| `raccoon-thief` | ✅ Real art (`raccoon-thief-var-0.png`) |
| `raccoon-elite-heist-capo` | ✅ **Now wired** (`raccoon-elite-heist-capo-v1-var-9.png`) |
| `raccoon-bottle-rocketeer` | ⏳ Still placeholder (maps to `raccoon-thief`) |

---

## Apple score

1🍎 — Brief authoring + wiring (1-line config change). Art-only assets are review-ledger-exempt. No gameplay mechanics changed.
