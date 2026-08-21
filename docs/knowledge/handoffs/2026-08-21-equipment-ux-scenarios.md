# Equipment UX scenarios

**Date:** 2026-08-21  
**Author:** Copilot App (UX Designer)  
**Session Branch:** nalfeo-equipment-ux-redesign

## Summary

Completed the explicit, manifest-driven Equipment A|B scenario contract. The UI-probe setup now captures the five requested interaction states without inventing scenarios from screenshot folders:

- Equipment: opened panel with no forced hover, preview, filter, or tooltip.
- Equipment Hover (Equiped): equipped Head tooltip.
- Equipment Hover (Duplicate): equipped and bag Iron Helm comparison with no delta.
- Equipment Hover (Empty Slot): Leather Boots comparison with an empty Feet slot.
- Equipment Hover (Stats delta): generated Runed Chain Hauberk replacing Iron Breastplate with a non-zero delta.

Generated equipment previews now calculate the same read-only swap delta as catalog equipment. The scenario fixture uses a valid common generated item with an immutable probe run key.

## Visual evidence

Current captures and Azure LLM reviews are stored session-locally at:

`files/visual-review/after/v0.1.0/{equipment,equipment-hover-equipped,equipment-hover-duplicate,equipment-hover-empty-slot,equipment-hover-mixed-delta}.{png,review.json}`

All five capture contracts report ten declared slot regions and zero deterministic geometry blockers. The Azure reviews remain `needs-work`; their subjective tooltip/stat-panel critiques require the maintainer's requested finding-by-finding disposition before further design changes.

No `before/live-dev` evidence was created: this workspace has no checked-in release baseline or detached baseline worktree. Capturing current-branch pixels as live evidence would fabricate provenance. Populate that side from the release capture workflow or an explicitly provisioned immutable release checkout.

## Validation

- `npx vitest run tests/ecs/equip-delta-preview.test.ts` — 16 passed.
- `npm run test:e2e -- tests/e2e/inventory-flow.test.ts` — 25 passed.
- `npx vitest run tests/unit/visual-review-agent-cli.test.ts` — 19 passed.
- `npm run verify:fast` — passed (131 files, 1,818 tests).

## Systems touched

inventory, hud-ux, devtools, mcp-tooling

## Apple estimate

**Estimated:** 3🍎  
**Actual:** 3🍎
