# Remove postprocess A/B

## Apples

Estimated: 🍎🍎🍎  
Actual: 🍎🍎🍎  
Verdict: exact

## Done

- Removed the global postprocess A/B reprocess UX from devtools.
- Simplified the postprocess debugger to a linear trace with slicing + live step output.
- Deleted the obsolete reprocess CLI/endpoint plumbing and related helper code.
- Removed stale approval/lab leftovers and updated the copy that still referenced reprocess flows.

## Verification

- `npm run verify:fast` ✅
- `npm run verify` stalled in `knip` dead-code analysis, so I stopped it after the fast gate passed
