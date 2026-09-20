# Floor 6 player economy controls

## Systems touched

floor6-scenario, scenario-presentation, main-game-scene, floor6-tests

## Summary

- Extended the renderer-neutral Floor 6 construction contract with authored upgrade offers and authoritative sell/upgrade requests.
- Tapping an occupied construction site now opens an inspection picker where a player can sell its tower or purchase an available upgrade; vacant sites retain the existing build picker.
- The scene continues to read all Relay, routes, sites, tower range/tier, and requisition state from the scenario-owned HUD projection. No combat, wave, or finale pacing data changed.

## Verification

- `npx tsc --noEmit` passed.
- `npx vitest run --project unit tests/unit/floor6-towers.test.ts` passed (9/9).
- The real-scene Floor 6 E2E attempt required an elevated Playwright launch; its combined run did not return a terminal result in this desktop shell. A subsequent isolated-port attempt started the e2e project but likewise returned no terminal result. Re-run it with `CRAWLER_E2E_LAB_PORT` set to a free port before merge.
- `npm run verify:fast` and `npm run verify:pr-prereqs` reached their type/lint phases but did not return terminal completion in this desktop shell; rerun before publishing if the shell process limitation is resolved.

## Review

`codex review --uncommitted` could not initialize because the desktop shell did not provide a home directory to the CLI. Manual diff review found no additional issue.
