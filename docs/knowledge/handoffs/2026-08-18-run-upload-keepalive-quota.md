# Handoff: fix dev-build run upload keepalive body-quota failure

## Systems touched

telemetry, devtools

## Apples

Estimated: 2. Actual: 2.

## Summary

Dev-build run uploads never completed from the shipped browser build. Both the
survey POST (~67 KB) and the silent POST (~67 KB) failed with
`TypeError: Failed to fetch`, while replaying the identical captured payload
directly against the same endpoint returned `201`.

Root cause was client-side, not CORS and not the backend. The Fetch Standard
gives `keepalive` requests — and `navigator.sendBeacon`, which shares the same
quota — a per-origin inflight body limit of **64 KiB**. `submitRunBundleUpload`
and `submitRunSurvey` both passed `keepalive: true` unconditionally. A real run
bundle serializes to ~67 KB, so the browser refused the request _before any
network activity_, surfacing an opaque `TypeError: Failed to fetch` that is
indistinguishable from a CORS/DNS failure. This is why endpoint preflight looked
correct (204, correct allow-origin/allow-headers), small browser POSTs
succeeded, and out-of-browser replay succeeded.

Fix:

- Only set `keepalive` when the serialized body is within the 64 KiB quota
  (`canUseKeepalive`), for both the silent and survey paths.
- Skip `sendBeacon` for oversized quit bundles, since it shares the same quota
  and would silently drop the upload.
- Treat a `sendBeacon` returning `false` as _not sent_ and fall back to `fetch`,
  with `keepalive: false`, instead of retrying the shared quota or reporting
  `ok: true` for an upload the browser refused.

## Observation (before/after, real browser + live endpoint)

Probed with Playwright/Chromium from the real shipped origin
(`https://nalfeo.github.io`) against the live Function
`https://crawler-dev-ingest.azurewebsites.net/runs`:

- Before (`keepalive: true`, 71,859 bytes) → `TypeError: Failed to fetch`
  — reproduces the exact shipped dev-session symptom.
- After (`keepalive: false`, 71,861 bytes) → **HTTP 201**.

Server behavior was independently confirmed unchanged: a 67,008-byte POST with
`Origin: https://nalfeo.github.io` returns `400 runStats must be an object` with
`Access-Control-Allow-Origin` intact, so the backend accepted and CORS-answered
a body of that size all along.

## Verification

- `npx vitest run tests/unit/run-bundle-upload.test.ts` — 11 passed.
- Fail-to-pass confirmed: with the source fix stashed, the 5 new tests fail;
  with it applied, all pass.
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`

## Notes

The server's 8 MiB `MAX_REQUEST_BYTES` cap was never the constraint here — the
limit that mattered was a browser-side quota, which is why it was invisible to
every server-side test and to direct payload replay.
