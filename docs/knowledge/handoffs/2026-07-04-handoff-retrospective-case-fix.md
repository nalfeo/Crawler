# Session Handoff: Case-insensitive handoff retrospective detection

## Date

2026-07-04

## Persona

Producer

## Systems touched

docs-tooling, ci-policy

## Apples

`1🍎 estimated, 1🍎 actual (exact)` — full JSON in `docs/knowledge/metrics/apples/2026-07-04-handoff-retrospective-case-fix.json`.

## What Was Done

Redo-and-ship of a lost 1🍎 follow-up that a prior session identified from PR #745
review feedback but never opened a PR for (its worktree evaporated). Two real
post-merge findings:

1. **Case-sensitivity mismatch (bug).** `scripts/agent/docs/lint-handoff.ts` used a
   **case-sensitive** `/^##\s+Retrospective\b/m` for its grandfather-skip (deciding
   a handoff predates the retrospective requirement and skipping subsection
   enforcement), while `scripts/agent/docs/handoff-parse.ts`'s
   `extractRetrospectiveSubsections` matched the heading **case-insensitively**.
   Consequence: a handoff written with a lowercase `## retrospective` heading
   **slipped past the lint** (grandfathered → its empty subsections went
   unenforced) even though the parser (and `promote-mistakes.ts`) still recognised
   the section. Fix: extracted a single shared, case-insensitive
   `RETROSPECTIVE_HEADING` regex + `hasRetrospectiveSection(content)` predicate in
   `handoff-parse.ts`, consumed by **both** the lint grandfather-skip and
   `extractRetrospectiveSubsections`, so the two agree by construction. Added 4
   unit tests to `tests/unit/handoff-parse.test.ts` proving a lowercase
   `## retrospective` heading is detected identically by both paths (plus a
   negative guard that a `### retrospective` h3 does not count).

2. **Overstated enforcement comment (docs accuracy).**
   `docs/knowledge/handoffs/TEMPLATE.md` claimed "a pre-flight guard rejects"
   handoffs missing a Retrospective. That is false: enforcement is **advisory** —
   `scripts/agent/docs/lint-handoff.ts` runs in `docs-update.yml` with
   `continue-on-error: true` (aggregated into a tracking issue, not a rejection)
   and via `npm run docs:check`, which is **not** part of `npm run verify`.
   Reworded the comment to point at `npm run docs:check` (advisory) accurately.

Observed in the real artifact (`npm run verify:fast` / the actual
`scripts/agent/docs/*` tooling, not a lab): before, `hasRetrospectiveSection` did
not exist and the two regexes disagreed on a lowercase heading; after, all 14
`handoff-parse` unit tests pass and the lint + parser share one predicate. No game
runtime touched, so no lab / wired-systems guard applies.

## Key Decisions Made

- **Single shared `RETROSPECTIVE_HEADING` regex applied per line** in both
  `hasRetrospectiveSection` and `extractRetrospectiveSubsections` — agreement is
  structural, not coincidental. A first cut tested the predicate against the
  **whole document** (`m` flag); code review showed that diverges from the
  per-line parser on a pathological `##\nRetrospective` (where `\s+` spans the
  newline), so the predicate now splits on newlines and uses the same per-line
  test as the parser. No `g`/`y` flag, so `.test()` is stateless and safe to
  reuse across calls.
- Removed the now-unreachable `if (retroIdx === -1) return []` in
  `extractRetrospectiveSubsections`; because the `if (!hasRetrospectiveSection(md))
return []` guard uses the identical per-line detection, `retroIdx >= 0` is
  genuinely guaranteed once execution proceeds.

## What's Next / Blockers

None. PR opened and shepherded to squash-merge in this session.

## Retrospective

### Lessons Learned

- When a "guard" and a "parser" both detect the same construct, factor the
  detector into one shared predicate; two hand-copied regexes drift (here, one
  gained `/i` and the other did not), silently opening a bypass.
- `docs:check` (and therefore `lint-handoff.ts`) is **not** wired into
  `npm run verify`, and its CI step is `continue-on-error` — so it is advisory,
  not a merge gate. Docs that describe enforcement must say so.
- The full `npm run verify` fails fast at the PR-prereq step until both a dated
  handoff **and** a review ledger exist on the branch — expected for a
  code-touching change; not a real regression.

### Mistakes Made

- First implementation made the shared predicate test the **whole document**
  while the parser detected **per line**; the doc comment even asserted "the two
  can never disagree." A code-review pass empirically found a `##\nRetrospective`
  input where `\s+` spans the newline in whole-string mode (predicate says
  present) but per-line `findIndex` returns `-1` (parser scans from offset 0) —
  the exact overstated-invariant class this PR's second finding is about. Fixed by
  detecting per line in both. Early signal: if you write "these can never
  disagree," construct an input that tries to make them disagree before believing
  the comment.
- Initially wrote the new import in `lint-handoff.ts` as a single long line;
  Prettier reflowed it to a multi-line import. Running `npx prettier --write` on
  the touched files up front (rather than discovering it at `format:check`) is the
  faster loop — an early signal the next agent should pre-format touched TS.

### Opportunities for Future Improvement

- Consider a tiny integration test that runs `lint-handoff.ts` against a temp
  fixture dir containing a lowercase-heading handoff with an empty required
  subsection, asserting a non-zero exit — this would cover the CLI call site
  directly (the current unit test covers the shared predicate + parser, and the
  lint's use of the predicate is guaranteed only by code inspection).
- `docs:check` being advisory-only means real handoff-lint regressions can merge
  unnoticed; wiring it into a non-blocking CI lane on PRs (or a required job for
  `docs/knowledge/handoffs/**` diffs) would surface them earlier.
