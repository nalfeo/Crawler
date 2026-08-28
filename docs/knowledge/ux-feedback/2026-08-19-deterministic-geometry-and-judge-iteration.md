# Deterministic geometry checks + judge-feedback iteration (equipment panel)

Status: promoted (shipped as code, not just a proposal)

## What changed

1. **Containment and alignment moved from LLM prose into deterministic checks.**
   - Containment generalized from icons-only to _any_ declared child region, and
     now reports which edges were crossed and by how many pixels.
   - `computeAlignmentBlockers` clusters slots into rows and columns and asserts
     every member of a row shares a top edge (and of a column, a left edge)
     within 1px.
   - Both are wired into the legacy equipment harvest by converting its geometry
     snapshot into regions, so the equipment surface gets the checks even though
     it does not declare `window.__visualReview`.

2. **Unsupported LLM geometry claims are suppressed.** When the deterministic
   checks find no alignment / overlap / containment defect, matching free-text
   findings are dropped, mirroring how `text_raster` evidence suppresses blur
   claims. This exists because the judge asserted the same false defects on
   every single run.

## Why name-based pairing was wrong

The first alignment implementation paired slots by name (`*1`/`*2`,
`left*`/`right*`) and demanded the pair share a row. Crawler's paper doll places
**Ring 1 in the top row and Ring 2 two rows below**, so it reported a ~198px
"misalignment" that is correct by design. Grid clustering is the correct
invariant. Cluster members must also be separated on the perpendicular axis, or
a wide row gets misread as a mis-aligned column.

## Recurring false claims (do not act on these without measuring)

| Claim                                 | Reality                            |
| ------------------------------------- | ---------------------------------- |
| "Ring 1 / Ring 2 misaligned by 2px"   | Different rows by design           |
| "Slot boxes touch, no breathing room" | Measured gaps are 41–43px          |
| "Tooltip overlaps the panel bottom"   | Tooltip sits 73px inside the panel |
| "Slot icons are not centered"         | Measured dx/dy are exactly 0       |
| "Text is blurry"                      | Already disproven by `text_raster` |

## A/B evidence

| State                 | Score      | Blocking findings | Artifact                               |
| --------------------- | ---------- | ----------------- | -------------------------------------- |
| `main` (baseline)     | 68.0 / 100 | 5                 | judged from a detached `main` worktree |
| branch, pre-iteration | 72.0 / 100 | 5                 | `files/visual-review/after/v6/`        |
| branch, final         | 72.0 / 100 | **0**             | `files/visual-review/after/v7/`        |

`main` reports `slots=8/10` (it predates ring1/ring2); the branch reports
`slots=10/10`.

## Panel fixes that survived the deterministic gate

- exact-thirds paper-doll row pitch (was 99/99/102px)
- taller, full-width inspector strip with more interior padding
- higher-contrast inspector background plus an accent frame
- recessed pixel-art bevel on every slot (light top edge, dark bottom edge)
- `— empty —` cue instead of a bare `Empty` literal

## Fixes the gate rejected

- **Stat row step 24px** overflowed the "Status" row past its region and failed
  `tests/e2e/inventory-flow.test.ts`. 23px is the largest value that passes.
- **Truncation factor 0.86em** overflowed the same gate; 0.95em retained.
- **Stats column 320px** was reverted with the row-step change.

The lesson: the judge asks for more spacing indefinitely, and the deterministic
e2e text-containment gate is the authority that says when to stop.
