# Handoff: CI recovery — accept bare ✅ Addressed marker for non-applicable findings

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎. Exact: narrow parser extension + targeted state tests,
no gameplay changes.

## Root cause

PR #1426's review thread `PRRT_kwDOSvo2Ms6R8vKh` had a `✅ Addressed:` reply from
`copilot-swe-agent` (asserting the finding was not applicable — the file already
had the correct single-pipe table rows). The CI recovery reconciler's
`shouldResolveThread` required the full `✅ Addressed in <sha>:` form because
`extractAddressedMarkerSha` returned `null` for the SHA-less form, causing
`markerNamesHead` to return `false`, which left the thread permanently
unresolved after 2 recovery attempts.

AGENTS.md documents `✅ Addressed` (without SHA) as the base valid marker form —
the SHA is "ideally" included. The parser did not honour this documented form,
creating a permanent stall for non-applicable findings.

## What changed

- **`.github/scripts/ci-recovery/state.mjs`**
  - Added `addressedBarePattern = /✅\s*addressed(?!\s+in\b)/i` — matches
    `✅ Addressed` when NOT followed by `\s+in\b`, so `✅ Addressed in <sha>` still
    routes through the strict lineage path.
  - Added exported `hasBareAddressedMarker(body)` function.
  - Updated `shouldResolveThread` to accept the bare form as a fallback after
    the SHA-bearing path returns false.  Fail-closed on wrong-SHA markers: if
    `✅ Addressed in <bad-sha>` is present, the negative lookahead in
    `addressedBarePattern` prevents it from leaking to the bare path.

- **`.github/scripts/ci-recovery/state.test.mjs`**
  - Added `hasBareAddressedMarker` to the import list.
  - Added 5 regression tests covering: bare form accepted (various forms),
    "✅ Addressed in ..." forms rejected, untrusted author rejected, PR #1426
    exact thread shape (regression), and wrong-SHA-does-not-fall-through guard.

## Key decisions

- Accepted the bare form only from trusted authors (`isTrustedComment` already
  checked by `shouldResolveThread`), matching the established trust model.
- Did not weaken the SHA lineage check: `✅ Addressed in <sha>` with a
  wrong-lineage SHA still rejects (the bare path is blocked by the negative
  lookahead on `\s+in\b`).
- No changes to `reconcile.mjs` — the thread iteration logic correctly skips
  lineage checks when `extractAddressedMarkerSha` returns null, so the fix is
  self-contained in `state.mjs`.

## Observe before done

- Before: `shouldResolveThread(thread, '9fcf158...')` returned `false` for the
  PR #1426 thread shape (`✅ Addressed: ...` without SHA from `copilot-swe-agent`).
- After: the same call returns `true`.  Validated via the new regression test
  `'shouldResolveThread accepts bare "✅ Addressed" from trusted copilot-swe-agent (PR #1426 regression)'`.

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs` — 36 pass, 0 fail
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 84 pass, 0 fail
- `npm run verify:fast` — exit 0

## Unresolved issues

- None.
