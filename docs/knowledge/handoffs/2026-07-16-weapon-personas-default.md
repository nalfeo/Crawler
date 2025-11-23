# Weapon personas enabled by default

**Date:** 2026-07-16
**Persona:** Game Designer

## Systems touched

ai-combat-balance

## Apples

Estimated 🍎🍎 · Actual 🍎🍎 · exact

## Summary

- Enabled the tuned weapon-specific stat and gear personas by default in the
  headless runner, progression helpers, AI Runner lab, local weapon sweep, and
  GitHub weapon-sweep workflow.
- Preserved deterministic legacy A/B controls through
  `--no-weapon-personas`, `weaponPersonas: false`, and the workflow boolean.
- Removed the experimental label now that the maintainer approved the default.

## Evidence

- The current broad main control run `29483586088` scored 582/600 (97.0%).
- `npm run ai:weapon-sweep` with no persona flag reported `Personas: enabled`;
  the persisted nine-run smoke artifact records `"weaponPersonas": true`.
- Focused persona/CLI tests passed (27/27), and `npm run verify:fast` passed
  (62/62 changed-scope tests plus physics, size, and weight coverage).

## Notes

The nine-run local smoke is wiring evidence, not a balance conclusion. The
maintainer supplied the already-completed >90% tuning result and explicitly
approved enabling personas by default, so no redundant broad cloud sweep was
launched in this session.
