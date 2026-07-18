# Handoff: brass-knuckles asset request (#1362)

**Date:** 2026-07-18  
**Session:** asset-forge (Copilot coding agent, branch `copilot/asset-request-brass-knuckles`)  
**Scope:** Floor 2 bludgeon weapon icon — `equipment/weapon/brass-knuckles`  
**Apple estimate:** 1–2 🍎 (pure art path, review-ledger-exempt)

---

## Summary

Handled the brass-knuckles asset request (issue #1362, PR #1530). Completed the
brief-authoring and planning stages. Generation is blocked by the `asset-request`
label having been removed from all Floor 2 issues during the G2-B containment
(see aggregate tracker #1303 comment at 2026-07-18T02:35:22Z).

## Systems touched

- `briefs/weapons/brass-knuckles.yaml` — authored and committed (new file)

## What was done

1. ✅ Ran `scripts/agent/preflight.sh` — clean
2. ✅ Read Graphics Designer persona + sprite style guide
3. ✅ Posted detailed plan comment on issue #1362 (plan comment on existing comment #5009154192)
4. ✅ Authored `briefs/weapons/brass-knuckles.yaml`:
   - **Orientation:** `diagonal` — brass knuckles are a flat, wide bludgeon weapon; vertical silhouette reads as a ring; diagonal shows the four-hole plate correctly
   - **Anchor:** `{x: 20, y: 48}` — grip/palm-side bottom-left, consistent with `compact-disk.yaml` diagonal weapon pattern
   - **VLM judge:** enabled (inherited from `weapon.json` defaults)
   - **Variations:** 2 seeds + `minVariations: 8` for sheet diversity
5. ✅ Brief validates (only fails on missing `AZURE_OPENAI_ENDPOINT` — expected in CI)
6. ✅ Committed brief to branch `copilot/asset-request-brass-knuckles`

## Current blocker

The `asset-request` label was stripped from all 70 Floor 2 equipment issues
(#1306–#1389) during G2-B containment on 2026-07-18 ~02:35Z. Issue #1362
(brass-knuckles) has **no `asset-request` label** and therefore the
`asset-request.yml` workflow will not trigger for it.

**To unblock:** Add the `asset-request` label to issue #1362 (and the other 4
bludgeon-wave issues: #1308 chain-flail, #1306 stone-maul, #1322 sun-hammer,
#1329 baseball-bat). This will trigger the `asset-request.yml` workflow to
synthesize a brief, generate sprites via Azure, and post results to the issue.

Note: The void-rapier run (blade wave re-run) has been queued since 03:01Z and
has not executed yet due to Actions runner saturation. Wait for runner capacity
to free before dispatching the bludgeon wave.

## Sprite judge pre-criteria

When the workflow runs and generates the brass-knuckles sheet, the judge/reviewer
must apply:

**Deterministic sensors (all must be `ok`):**

- `dimensions-exact`: 64×64 final sprite
- `alpha-binary`: no semi-transparent edges
- `palette-membership`: colors within kenney-roguelike palette
- `opaque-bbox-fits`: subject not clipped
- `opaque-ratio`: not too sparse or too filled
- `interior-transparency-holes`: no see-through gaps inside the body
- `anchor`: derivable in the bottom-left quadrant (grip area)
- `weapon.orientation: diagonal` with ±8° tolerance

**Eyeball checklist at 16px:**

- Four finger holes must read as distinct negative space
- Silhouette unambiguous as brass knuckles (not a ring, coin, or disc)
- Worn/grungy brass-gold tone on plate, dark shadow on palm bar
- Reads clearly on the dark `#2a2a32` floor tile at game scale

**VLM judge thresholds:** all three axes (style_match, brief_match, readability)
must be ≥ 3. Any axis < 3 = auto-reject.

## Post-generation pipeline (for the session that resumes this)

Once the `asset-request.yml` workflow completes for issue #1362:

1. Check the issue for the `✅ Asset-request pipeline complete` comment
2. Run `npm run sprites:checkin` to download from Azure blob store and create the
   art branch → opens an `asset-checkin` issue
3. Run the `asset-pr` skill to batch into an art-only PR
4. Wire: add `brass-knuckles` entry to `entity-sprite-mappings.json` or equivalent
   (check `npm run sprites:generate-wiring -- --since main` after art lands)
5. Wiring is a code PR — full gates + apple-scaled review harness
6. Observe: confirm sprite renders at game scale before closing

## Key decisions

| Decision                    | Choice                               | Rationale                                                            |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Orientation                 | diagonal                             | Wide flat weapon; vertical = ring-like silhouette                    |
| Brief location              | `briefs/weapons/brass-knuckles.yaml` | Matches runtime key segment; auto-resolves                           |
| Anchor                      | `{x: 20, y: 48}`                     | Grip bottom-left, consistent with compact-disk.yaml                  |
| Brief vs workflow synthesis | Both are present                     | This brief is for direct `sprites:run`; workflow synthesizes its own |

## Recovery notes

- Issue #1436 was closed as a duplicate of #1362 during G2-B containment. Work
  only on #1362.
- The `asset-request` label can be added by any maintainer via GitHub issue UI or
  `gh issue edit 1362 --add-label asset-request`
- If runner capacity is still saturated, use `workflow_dispatch` after labeling
  to force an immediate sweep

## Related issues / PRs

- PR #1530: This session's WIP PR
- Issue #1362: Canonical brass-knuckles asset request
- Issue #1303: G2-B aggregate tracker (full wave status + bludgeon wave mapping)
- Issue #1436: Duplicate (closed)
