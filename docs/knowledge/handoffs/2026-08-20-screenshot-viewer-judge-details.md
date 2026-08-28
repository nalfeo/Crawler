# Screenshot viewer judge details expander

## Systems touched

mcp-tooling, inventory

## Summary

Added an evaluator expander to the Screenshot Viewer Before/After cards so a
judge result is no longer reduced to only score + top findings.

Changes:

- `.github/extensions/screenshot-viewer/extension.mjs` now preserves a
  `details` payload for every attached review, including:
  - verdict and summary;
  - score derivation;
  - all axis scores, strengths, and issues;
  - all deterministic findings, blocking findings, recommended fixes, and
    precise fixes;
  - the full raw review JSON as `rawReview`.
- `.github/extensions/screenshot-viewer/renderer.mjs` now renders an accessible
  `Score details + judge comments` expander under each evaluator result, with a
  nested `Full raw judge response JSON` expander for the complete response.
- Screenshot viewer tests now lock in both the expander UI and full raw response
  preservation.

## Verification

- `node --test .github/extensions/screenshot-viewer/tests/*.test.mjs` — 37/37
  passed.
- `extensions_reload` completed and the Screenshot Viewer canvas was reopened
  and refreshed.

## Notes

The viewer still attaches results by exact screenshot path and basename
(`same-dir/same-name.review.json`). This change only affects how an already
attached evaluator result is displayed.
