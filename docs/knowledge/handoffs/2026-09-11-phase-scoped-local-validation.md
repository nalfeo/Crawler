# Session Handoff: Phase-Scoped Local Validation

## Date

2026-09-11

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact — four policy/test-contract files; no runtime change).

## What Was Done

- Replaced the repeated-local-`verify:fast` instruction with a validation-phase rule: run focused unit/type/lint/docs checks after coherent edits or before a risky refactor.
- Preserved `npm run scope` as the existing, fail-safe selector for extra heavy checks, `npm run verify:fast` before handoff/PR, and `npm run verify:pr-prereqs` before publication.
- Updated the closeout and DevOps guidance, and added the exact canonical policy line to the deterministic session-instructions check.
- Recovered the PR's inherited CI lint failure by applying Node globals to the full `scripts/agent/**/*.mjs` tree; the upstream preflight bootstrap test temporarily stubs `console.error`.

No runtime or visual artifact changed; this is documentation/tooling policy only.

## Key Decisions Made

Used the established `npm run scope` classifier rather than introducing a second validation dispatcher. This keeps the classifier's conservative behavior and CI/full-suite obligations unchanged.

## What's Next / Blockers

The current host cannot run `tsx` commands because Node fails in `os.userInfo()` with `uv_os_get_passwd` / `ENOMEM`; this affected `scope`, the focused documentation check, `docs:check`, and `verify:fast`. `verify:pr-prereqs` was run before this handoff existed and correctly reported the missing handoff. Rerun the normal prerequisites once the host error is resolved.

First-request rollout telemetry: unavailable because the required `velocity:scan` baseline could not start without dependencies, and after dependencies were installed Node hit the same host-level error. Cumulative rollout telemetry: unavailable for the same reason; no telemetry was fabricated.

## Retrospective

### Lessons Learned

The existing local scope classifier already has the correct safe-default contract, so the narrowest durable change was to make session guidance invoke it at phase boundaries rather than add new tooling.

### Mistakes Made

The initial dependency bootstrap failed at the Playwright postinstall, then an `--ignore-scripts` install exposed the independent Node `ENOMEM` problem. The early signal was `tsx` being absent after preflight; validate the dependency bootstrap before scheduling a measurement command.

### Opportunities for Future Improvement

Repair the Windows Node/passwd-memory failure and run a bounded velocity experiment or at least the baseline scan, so the policy's token-efficiency claim can gain first-request and cumulative evidence.
