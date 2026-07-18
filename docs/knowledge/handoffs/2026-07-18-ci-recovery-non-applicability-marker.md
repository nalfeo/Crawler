# Handoff: CI recovery non-applicability marker parsing

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎. Exact: narrow parser addition plus focused regression tests.

## What changed

- Added `nonApplicabilityMarkerPattern` constant and exported `isNonApplicabilityMarker(body)`
  function to `.github/scripts/ci-recovery/state.mjs` — recognizes the
  `✅ Addressed (deterministic non-applicability): <explanation>` format used by trusted bots
  when a review finding is not applicable to the current code (no fix SHA needed).
- Updated `shouldResolveThread` to accept the non-applicability marker form from trusted bots,
  in addition to the existing `✅ Addressed in <sha>` form.
- Clarified the reconciler task description in `.github/scripts/ci-recovery/reconcile.mjs` to
  explicitly document both marker formats and when to use each:
  - Fix-based: `✅ Addressed in <sha>: <note>`
  - Non-applicable: `✅ Addressed (deterministic non-applicability): <explanation>`
- Added 4 regression tests in `.github/scripts/ci-recovery/state.test.mjs` covering:
  - `isNonApplicabilityMarker` acceptance and rejection cases
  - `shouldResolveThread` accepting a trusted non-applicability marker
  - `shouldResolveThread` rejecting the same marker from an untrusted author
  - `shouldResolveThread` rejecting the marker when a later untrusted comment follows it

## Root cause

PR #1530 had review thread `PRRT_kwDOSvo2Ms6R894T` that remained unresolved after
`copilot-swe-agent` replied with `✅ Addressed (deterministic non-applicability): ...`.

The `shouldResolveThread` function delegates to `markerNamesHead` → `extractAddressedMarkerSha`,
which requires the pattern `✅ Addressed in <sha>`. The non-applicability format has no SHA,
so `extractAddressedMarkerSha` returned `null`, `markerNamesHead` returned `false`, and
`shouldResolveThread` returned `false` — leaving the thread permanently unresolved.

The reconciler task instructions already mentioned "deterministic non-applicability" as a valid
resolution path but the parser had no support for the resulting marker format.

## Observe before done

- Before: `shouldResolveThread({ comments: { nodes: [{ body: '✅ Addressed (deterministic non-applicability): ...', author: { login: 'copilot-swe-agent' }, authorAssociation: 'NONE' }] } }, headSha)` returned `false`.
- After: same call returns `true` (trusted bot, non-applicability format, no SHA required).
- Verified via 4 new regression tests in `state.test.mjs` (35 total, 0 failures).
- Reconcile tests unaffected (84 pass, 0 fail).

## Verification run

- `node --test .github/scripts/ci-recovery/state.test.mjs` (35 tests, 0 fail)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` (84 tests, 0 fail)
- `npm run verify:fast` (exit 0; 1 pre-existing failure in epic-status unrelated to this change)

## Unresolved issues

None.
