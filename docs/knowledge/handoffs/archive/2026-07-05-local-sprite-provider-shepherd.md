# Session: PR #790 Shepherd — Local A1111 Sprite Provider

**Date:** 2026-07-05  
**Complexity:** 3 🍎 (shepherd session)  
**Branch:** nalfeo-local-sprite-provider  
**PR:** #790  
**Persona:** Producer  
**Status:** Review threads resolved; auto-merge armed

## Systems touched

ci-policy

## Systems Touched

sprites, provider

## Summary

Took over PR #790 end-to-end (original owner archived). CI was already green
(ci aggregate, commit-lint, Headless Floor 1 Gate); the sole merge blocker was
**7 unresolved `copilot-pull-request-reviewer` threads** — the repo enforces
`required_conversation_resolution: true`, which blocks auto-merge even with
green CI. Fixed every thread in real code, ran an apple-scaled code-review loop
that surfaced a second real bug, then owner-resolved all threads and armed
`--auto --squash`.

## Review threads resolved (all fixed in code, not just replied)

1. **Generation loop under-fills the grid** — the loop iterated
   `request.variants` (= `variantCount(brief)` = _content_ cells) but computed
   grid position from the loop index, so a non-trailing empty cell left the
   final cell as un-painted magenta. Fixed to iterate every `rows*cols` cell
   with a separate `contentIdx` counter driving variation/seed for content
   cells only. Proven with a regression test (2×2, `emptyCells:[[0,0]]`).
2. **Per-cell dims not multiples of 8** — SD works in an 8×-downsampled latent
   space, so txt2img width/height must be multiples of 8. Cell size is now
   rounded down to a multiple of 8 and centered within the slot (`offsetX/Y`);
   256/2 slot went 118→112.
3. **`negativPrompt` → `negativePrompt`** spelling (option, class field, ctor,
   usage, and factory local var).
4. **`timeoutMs` doc** corrected to match the real default
   (`DEFAULT_PROVIDER_TIMEOUT_MS` = 120 000 ms).
5. **`steps` doc** corrected — the "model-aware" default is not implemented
   (always 20).
6. **Empty-cell test name** — renamed `'marks empty cells as transparent'` →
   `'fills empty cells with the magenta sheet background'` to match the opaque
   magenta assertion.
7. **Factory coverage** — added unit tests for the `local-a1111` factory path
   (constructs when `LOCAL_A1111_MODEL` set; throws when missing).

## Code-review loop (3 apples → plan_review + code_review, looped until clean)

- **Round 1 — GitHub Copilot PR reviewer:** the 7 threads above. All fixed.
- **Round 2 — independent gpt-5.4 review:** found a real, reproducible
  **`bad-grid` corruption bug** — the provider decoded each returned PNG but
  never checked its dimensions, and the stitch loop clipped only at `sheetSize`
  (not the slot boundary), so a backend returning a larger-than-requested image
  overwrote the gutter and bled into the adjacent slot (the slicer then
  collapsed two cells into one). Fixed with:
  - strict per-cell dimension validation after decode → throws
    `ProviderError('bad-grid', …)` on any mismatch (over- or under-sized);
  - a defensive stitch clamp to `cellW`/`cellH` so nothing can bleed across a
    slot even if the check is bypassed;
  - a regression test asserting `generateSheet` rejects with `kind:'bad-grid'`
    when the backend returns an oversized image.
  - Also updated two existing mocks (`respects seed`, `fills empty cells`) to
    echo the requested dimensions (a compliant backend) so they don't trip the
    new check.
- **Round 3 — independent claude-sonnet-4.6 review:** _No substantive
  concerns._ Loop clean.

Recorded in `docs/knowledge/review-ledgers/2026-07-04-local-sprite-provider.review-ledger.json`
(bumped 2→3 apples; `plan_review` + `code_review` stages; validates green).

## Observe-before-done (rule #10)

This is a **build-time tool** (`scripts/sprites/**`) with no ECS/Phaser/sim
runtime — the integration test suite _is_ the real artifact. Both bugs were
reproduced deterministically before/after:

- Loop bug: temporarily restored the buggy `request.variants` bound → the new
  regression test failed ("expected 3 calls, got 2"); restoring the fix made it
  pass.
- bad-grid bug: round-2 reviewer reproduced `sliceSheetFromBrief` recovering 1
  cell instead of 2 from an oversized-image sheet; the new `bad-grid` test now
  makes the provider fail fast instead of stitching a corrupt sheet.

No `src/core`, `src/game/ai`, or `src/engine` files touched → **Floor 1 Gate
unaffected** (rules #12/#13 respected; no seeds bent, no gate weakened).

## Validation

| Check                                    | Status                       |
| ---------------------------------------- | ---------------------------- |
| `npm run verify:fast`                    | ✅ 145 unit tests, type+lint |
| Provider + factory + generate-one tests  | ✅ 40 passed                 |
| Review ledger (`review:ledger validate`) | ✅ valid 3-apple ledger      |

## Commits

- `c738fbae fix: address review feedback on local A1111 sprite provider`

## Merge

Required checks: `ci` + `commit-lint` only; `enforce_admins:false`; no required
human review (`reviewDecision` empty is not a block). Armed via
`gh pr merge 790 --auto --squash`. Copilot-reviewer threads were owner-resolved
via the `resolveReviewThread` GraphQL mutation (the auto-resolve bot skips
another App's threads).
