# Session Handoff: Sprite catalog lab renders generated (and sheet) sprites on GitHub Pages

## Date

2026-07-02

## Persona(s) adopted

Producer (default) — a focused, single-layer lab bug fix; no routing to specialists needed.

## Routing verdict

✅ right persona — small, contained fix in the labs layer plus a unit test.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — one bug fix in a single lab file + a new helper module + a deterministic test, exactly the "small bug fix / a test" tier.

Hello kitties: 2/5 = 0.40 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-sprite-catalog-generated-render.review-ledger.json`
Stages: plan_review ✅ (reviewer_model gpt-5.4, 2 concerns / 2 resolved) · dual_plan_synthesis N/A · code_review N/A · multi_model_review N/A (2🍎 tier requires only plan_review)
`npm run review:ledger -- validate <path>` → pass.

## What Was Done

The sprite-catalog lab (`?lab=sprite-catalog`) built **root-absolute** asset URLs
(`/assets/...`) for the manifest fetch, the generated-sprite preview `img`, the
sheet-image loader, and the sheet-overview `img`. Those ignore the Vite `base`, so
on GitHub Pages (base `/Crawler/dev/`) they resolved to `nalfeo.github.io/assets/...`
and 404'd — leaving broken images (broken-image icon + `alt` text). It worked
locally only because local dev uses base `/`.

- Added `src/labs/sprite-catalog-lab/asset-urls.ts` with two pure, base-aware
  helpers (`generatedSpritePreviewUrl`, `sheetImageUrl`) delegating to the engine's
  existing `resolvePublicAssetUrl`. `generatedSpritePreviewUrl` defensively
  normalizes the stored `assetPath` (handles `generated/x.png`, `/generated/x.png`,
  `assets/…`, `/assets/…`, empty/missing → `generated/<spriteId>.png` fallback).
- Wired the 4 URL sites in `src/labs/sprite-catalog-lab/index.ts` to the helpers;
  the manifest fetch now uses the engine's exported `DEFAULT_MANIFEST_URL`.
- Added `tests/unit/sprite-catalog-lab-asset-urls.test.ts` (10 cases): base
  application for `/`, `/Crawler/dev/`, `/Crawler/`; assetPath-vs-spriteId
  fallback; leading-slash / already-`assets/`-rooted normalization; and a
  regression guard that a subpath base never yields a root-absolute `/assets` URL.
- Left the dev-only sidecar `fetch`es (`/__sprite-catalog-add`,
  `/__sprite-metadata-run`) unchanged — they only exist under `npm run lab`, never
  on GitHub Pages.

## Runtime / real-artifact observation

Observed in a **real GitHub-Pages-base build** — `DEPLOY_ENV=dev npm run build`
(base `/Crawler/dev/`) served via `vite preview`, driven with Chrome DevTools.
This is the actual deployed artifact for this bug, not a lab-forced code path
(the lab _is_ the shipped surface here).

- **Before:** generated preview `img.src = …/assets/generated/sewer-grate-floor-tile-v1-var-1.png`,
  `naturalWidth: 0` (broken). Network: `/assets/generated/manifest.json` → **404**,
  sheet `/assets/generated/custom-pixel-sprites.png` → **404**.
- **After:** `img.src = …/Crawler/dev/assets/generated/sewer-grate-floor-tile-v1-var-1.png`,
  `naturalWidth: 256` (renders — screenshot captured). Sheet preview
  `naturalWidth: 203`. Network: manifest + both sheets + generated PNG all
  resolve under `/Crawler/dev/…` and return **200**.

## What's Next

Optional follow-up (out of scope, not a regression from this change): generated
entries appear both in the bundled static `sprite-catalog.json` **and** are pushed
again by the runtime manifest merge in `index.ts`, so approved variants can show as
duplicate catalog rows. Worth de-duping in a future pass.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-sprite-catalog-generated-render`
- All tests passing: yes (`npm run verify` green except the handoff prereq this file satisfies)
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

Guard telemetry captured via: none (`files/guard-telemetry.jsonl` absent this session)

## Test Results

- `npm run verify:fast` → ✅ (typecheck + lint + changed unit tests; 10/10).
- `npm run verify` → ✅ typecheck, lint, format, guards, unit + integration
  (53 passed | 1 skipped), build; headless Floor-1 gate deferred (no core/ai/balance
  touched); PR-prereqs: review ledger ✅, handoff satisfied by this file.

## Key Decisions Made

- Reused the engine's existing `resolvePublicAssetUrl` (the established
  "store root-absolute, resolve against base at load" pattern, mirroring
  `withBasePath` in `src/engine/sprites/registry.ts`) rather than rewriting stored
  catalog paths — keeps the catalog portable and the fix localized.
- Extracted the URL logic into a tiny separate module so the regression test stays
  deterministic and avoids importing the whole lab (which calls `registerLab(...)`
  and pulls lil-gui at module load).

## Retrospective

### Lessons Learned

- Absolute `/assets/...` URLs are a base-path footgun for any DOM code (labs,
  plain `img`/`fetch`) that doesn't go through Phaser's loader or a base-aware
  helper. The engine already had `resolvePublicAssetUrl` / `withBasePath` for
  exactly this — new UI surfaces should default to them.
- To reproduce base-path bugs you must build with the real deploy env
  (`DEPLOY_ENV=dev`, base `/Crawler/dev/`) and `vite preview`; `npm run lab` uses
  base `/` and hides the bug entirely.
- Playwright MCP held a stale profile lock ("Browser is already in use"); the
  chrome-devtools MCP backend worked as a drop-in for navigation + `evaluate` +
  network inspection.

### Mistakes Made

- Forgot Prettier on the two new files → first `npm run verify` failed at the
  format step. Early signal: run `npm run format` (or `verify:fast` includes lint
  but not format-check) before the full verify on any brand-new file.

### Opportunities for Future Improvement

- Consider a lint rule / guard flagging root-absolute `/assets/` string literals in
  `src/**` DOM code, steering authors to `resolvePublicAssetUrl`.
- De-dupe generated catalog entries (static JSON vs. runtime manifest merge) noted
  in "What's Next".
