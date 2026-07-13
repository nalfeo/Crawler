# Handoff — Visual review viewport option

## Date

2026-07-13

## Persona

DevOps Engineer

## Systems touched

devtools, ci-policy

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact — one CLI option, focused parser coverage, and
direct tooling documentation).

## What Was Done

- Added optional `--viewport WIDTHxHEIGHT` parsing to
  `scripts/agent/review/visual-review-agent.ts`.
- Preserved the existing `1600x1000` viewport when the flag is omitted.
- Applied the parsed viewport to the Playwright browser context.
- Rejected missing, zero, negative, fractional, incomplete, and wrong-separator
  values with an actionable error.
- Added deterministic unit coverage for valid lowercase/uppercase separators,
  malformed values, a missing value, and default behavior.
- Documented the option in the visual-review skill.

## Key Decisions

- Kept parsing strict: dimensions are positive base-10 integers and the separator
  is `x` or `X`.
- Exported the existing parser and guarded the CLI entrypoint using the repository's
  established import-safe CLI convention, allowing focused tests without launching
  Chromium or Azure vision.
- Did not touch HUD production files, labs, setup/capture helpers, or screenshots.

## Validation

- `npx vitest run --project unit tests/unit/visual-review-agent-cli.test.ts --reporter=dot`
  — 11 tests passed.
- `npm run verify:fast` — passed.

## Follow-up

None.
