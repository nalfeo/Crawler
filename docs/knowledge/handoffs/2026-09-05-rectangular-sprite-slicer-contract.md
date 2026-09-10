# Handoff: enforce rectangular sprite-sheet geometry at slicing

**Date:** 2026-09-05
**Persona:** QA Engineer / implementer
**Apples:** 3 estimated, 3 actual — 🎯 Exact; the change stayed within the planned sprite-provider/slicer contract and focused regression coverage.

## Systems touched

sprites

## Outcome

The real `sliceSheetFromBrief()` path now consumes `sheetPixelDimensions()` and validates provider output dimensions before content-aware slicing. A sheet must match the declared rectangular canvas or preserve it by one uniform positive integer scale; non-integral or axis-inconsistent output is rejected before extraction. This preserves existing deterministic provider upscaling while preventing silent geometry drift.

## Review findings addressed

- Added a real slicer-boundary regression for a 1024x768, 4x3 brief and exact 256x256 source-cell contract.
- Added deterministic rejection coverage for a provider sheet whose dimensions do not match the declared geometry or a valid integer scale.
- Existing Azure rectangular multipart coverage and Foundry factory parity coverage remain green.

## Validation

- `npm test -- --run tests/unit/sprites/slice-sheet.test.ts tests/unit/sprites/azure-openai.test.ts`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs`

All focused tests passed (57 tests); fast verification passed (369 tests).
