# Session Handoff: Launch Context Popup

## Date

2026-07-05

## Persona(s) adopted

- Producer
- UX Designer

## Routing verdict

✅ right persona — cross-cutting UI plumbing across shared helpers, labs/devtools entrypoints, and the worktree-server extension.

## Apples

Estimated: 🍎🍎
Actual: 🍎🍎
Verdict: 🎯 Exact

## Systems touched

docs-tooling, devtools

## What Was Done

1. Added a pure shared launch-context parser/formatter in `src/shared/launch-context.ts`.
2. Added a reusable popup renderer in `src/launch-context-banner.ts` and called it from both `src/lab-main.ts` and `src/devtools-main.ts`.
3. Extended `.github/extensions/worktree-server-status/extension.mjs` to resolve the active branch's open PR and attach launch-context query params to lab/devtools URLs.
4. Updated `.github/extensions/worktree-server-status/renderer.mjs` so clicked labs/devtools links open with the related session/PR context.
5. Added unit coverage in `tests/unit/shared/launch-context.test.ts`.
6. Captured guard telemetry for this session in `docs/knowledge/metrics/guard-telemetry/2026-07-05-launch-popup.json`.

## Validation

- `npm run verify:fast` ✅
- Observed the popup on `http://127.0.0.1:4178/devtools.html?...` ✅
- Observed the popup on `http://127.0.0.1:4178/lab.html?...` ✅

## Notes

- The popup is dismissible and persists dismissal per sessionStorage key.
- When an open PR is available, the popup includes the PR number/title and links to the PR URL.
