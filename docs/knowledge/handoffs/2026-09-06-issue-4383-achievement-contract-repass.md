# Issue #4383 achievement contract repass

## Verdict

Recommended. The remaining review finding was a tooling false positive, and
the ownership detector now distinguishes achievement work from downstream
references to an achievement slice.

## Systems touched

agent-epic-lint, floor-factory

## Apples

Estimated 2, actual 2 — exact. The repass required a narrow lint heuristic
change and one regression fixture adjustment, with no runtime or schema
changes.

## Change

Narrowed achievement ownership detection to explicit ownership verbs and
achievement-integrated phrasing. Generic nouns such as `slice`, `coverage`,
and `data` no longer cause a downstream release node that says “after the
achievement slice passes” to be treated as a second achievement owner. The
regression fixture now uses that exact downstream-reference wording.

## Evidence

- `npm run test:unit -- tests/unit/agent/floor-epic-lint.test.ts`
- `for file in docs/knowledge/epics/*/*.epic.json; do npm run epics:lint-floor -- "$file"; done`
- `bash scripts/agent/verify-fast.sh`
