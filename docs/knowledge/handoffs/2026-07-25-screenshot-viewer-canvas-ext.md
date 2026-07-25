# Session Handoff: screenshot-viewer canvas extension

**Date:** 2026-07-25  
**Session slug:** screenshot-viewer-canvas-ext  
**Apple estimate:** 2🍎  
**Closes:** #1946

## Systems touched

canvas-extensions, tooling

## What Was Done

Added a new `screenshot-viewer` canvas extension at `.github/extensions/screenshot-viewer/` that gives agents and maintainers a quick way to browse all screenshots taken during a session.

### New files

- **`.github/extensions/screenshot-viewer/extension.mjs`** — the extension entry point.
  - Registers `createCanvas({ id: 'screenshot-viewer' })`.
  - Boots one loopback `http.createServer` per open canvas instance.
  - Hooks `onPostToolUse` to intercept every `playwright-browser_take_screenshot` call and register the resulting file path live.
  - On-demand directory scan (`POST /api/refresh`, or `refresh` action) covers:
    - `<workspace>/files/visual-review/**` (visual-review agent output)
    - `<workspace>/files/**` (other files/ subdirs)
    - `<workspace>/` root (immediate children, `page-*.png` etc.)
    - `<cwd>/` (if different from workspace)
  - Serves images at `GET /img?path=<encoded>` with strict allowlist guard (path must be in the registry OR fall within `trackedWorkspacePath`/`trackedCwd`).
  - SSE at `/events` pushes state updates to all open canvas instances in real-time.
  - Agent-callable actions: `list_screenshots` and `refresh`.

- **`.github/extensions/screenshot-viewer/renderer.mjs`** — pure HTML/CSS/JS gallery renderer.
  - Responsive `auto-fill` grid of thumbnail cards (220 px min column).
  - Click or keyboard-activate a card to open a full-size lightbox (Escape / click-outside to close).
  - Thumbnails lazy-load with graceful error fallback.
  - Status bar shows screenshot count, last scan time, and workspace path.
  - "Live" badge driven by SSE; falls back to polling if SSE drops.

- **`.github/extensions/screenshot-viewer/tests/renderer.test.mjs`** — 13 renderer smoke tests (all green):
  - Title / heading renders.
  - XSS: instanceId is HTML-escaped.
  - Presence of all key DOM IDs (gallery, status-bar, error-box, lightbox, etc.).
  - SSE / EventSource subscription.
  - Refresh button + polling interval.
  - API routes `/api/state`, `/api/refresh`, `/img?path=`.
  - Responsive CSS (auto-fill grid).
  - Keyboard accessibility (Escape handler).
  - No credentials embedded.
  - `escapeHtml` present in script.
  - Empty state references `browser_take_screenshot`.
  - Live badge element.

### Modified files

- **`package.json`** — added `.github/extensions/screenshot-viewer/tests/*.test.mjs` to `test:guards` glob list.

## Design decisions

1. **No external disk cache** — images are served directly from the local filesystem path; no intermediate copy.  The allowlist guard (registry + workspace root prefix) prevents the `/img` route from being used as a general filesystem relay.
2. **Token-based CSRF** — every HTTP request must include `?token=<hex>` matching the per-instance random token, consistent with other extensions.
3. **Source tagging** — each screenshot entry is tagged `live` (detected via hook) or `scanned` (discovered by directory scan). Live entries are preferred; the registry upgrades a scanned entry to `live` if a subsequent hook fires for the same path.
4. **Screenshot discovery logic** — tries the explicit `filename` toolArg first, then falls back to a regex match on the tool result text for the default `page-{timestamp}.png` pattern.

## Verification

- 13 renderer tests pass: `node --test ".github/extensions/screenshot-viewer/tests/*.test.mjs"`.
- `test:guards` glob updated; existing guard test suite unaffected.
- No production game code touched; no ECS systems added or moved; no runtime wiring changed.
- Parallel validation: CodeQL scan skipped (trivial tooling change); code review tool had a model-availability environment issue unrelated to code.

## Unresolved issues

None.

## Recommended next steps

- Consider adding an `extension.test.mjs` that uses a mock HTTP server to test route handling and path-allowlist enforcement.
- If agents frequently need to programmatically open a specific screenshot in the lightbox, add an `open_screenshot({ path })` canvas action.
