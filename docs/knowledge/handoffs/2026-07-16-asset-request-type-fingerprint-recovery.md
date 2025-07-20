# Handoff: asset-request type fingerprint recovery

## Date

2026-07-16

## Persona

Producer -> QA Engineer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 🍎🍎, actual 🍎🍎.

## What changed

- Added a type-aware fingerprint upgrade path for asset requests only when `type` changes boss-size inference, while preserving the existing legacy hash for unaffected requests.
- Carried the legacy fingerprint through parsed issue payloads so the ingester can still recognize already-claimed or rejected legacy requests when their stored semantics still match.
- Taught the ingester to re-enqueue only when a legacy claim's stored size semantics differ from the current issue body, fixing the type-only edit case without duplicating unchanged work.
- Added regression coverage for the parser fingerprint split and for both matching and mismatched legacy-ingest claim paths.

## Verification

- `npx vitest run tests/unit/sprites/asset-request.test.ts tests/unit/sprites/issue-ingester-controller.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-16-asset-request-type-fingerprint-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`
- `parallel_validation` (pending after commit)

## Review thread outcomes

- `scripts/sprites/asset-request.ts:125-129`: fixed by making the fingerprint change when explicit type is the deciding boss-inference signal, plus legacy-claim compatibility in the ingester.

## Unresolved issues

- None.
