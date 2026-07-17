# Session Handoff: Floor 2 Equipment Epic — A0 Bootstrap

## Date

2026-07-17

## Persona

Producer

## Systems touched

<!-- docs/tooling only — no runtime system impact -->

## Apples

3🍎 estimated, 3🍎 actual (exact)

## What Was Done

Created the durable control plane for the Floor 2 equipment epic (issue #1264):

1. **`docs/knowledge/epics/floor-2-equipment/epic-state.schema.json`** — JSON Schema
   Draft-07 validating the state file structure (slices, gate checkpoints, status
   lifecycle, dependency references).

2. **`docs/knowledge/epics/floor-2-equipment/epic-state.json`** — Initial state with all
   7 slices (A0–C2) fully specified, all in `planned` status except A0 which is `validated`.
   Hard release gate defined: 1.7×–2.3× DPS ratio independently at level 1→6 and level 6→11.

3. **`docs/knowledge/epics/floor-2-equipment/PLAN.md`** — Human-readable epic plan
   with slice descriptions, dependency graph, DPS formula, acceptance criteria, and
   governance rules.

4. **`scripts/agent/epic-status-lib.ts`** — Pure Zod-validated logic for:
   - `validateEpicState` — parse + validate + referential-integrity check
   - `computeReadySlices` — compute materialization candidates
   - `formatStatusTable` — ASCII status table
   - `formatMaterializationPlan` — markdown child-issue materialization plan

5. **`scripts/agent/epic-status.ts`** — CLI entry point: offline status, `--github
--reconcile` mode (read-only audit of issue states), `--materialization-plan` mode.

6. **`package.json`** — Added `"epic:status": "tsx scripts/agent/epic-status.ts"`.

7. **`tests/unit/epic-status.test.ts`** — 37 unit tests covering validation, ready-slice
   computation, formatter output, parseArgs, and deferred-slice exclusion.

`npm run verify:fast` passes: 1260 tests across 87 test files.

## Review Harness Summary

**3🍎 — plan review + code review loop.**

- **Plan review (gpt-5.4, high):** 5 concerns surfaced (blocking: DPS formula
  underspecified, B2/B3 missing items.ts scope, B4 wrong acceptance criteria;
  non-blocking: A0 premature `validated`, validator too shallow). All 5 resolved
  before implementation.
- **Code review rounds:**
  - Round 1 (claude-sonnet-4.6): 3 concerns — `computeReadySlices` surfaced
    deferred slices; `parseArgs` lacked tests; GitHub API cast unsafe.
    All 3 fixed.
  - Round 2 (claude-sonnet-4.6): 1 concern — `formatMaterializationPlan` also
    leaked deferred slices into "Blocked" section (mirroring the round-1 bug in
    a different function). Fixed + test added.
  - Round 3 (claude-sonnet-5): clean, no findings.

**Ledger:** `docs/knowledge/review-ledgers/2026-07-17-floor2-equipment-a0.review-ledger.json`

## Key Decisions Made

- **Schema-first design**: `epic-state.schema.json` is the authoritative contract;
  the Zod schema in `epic-status-lib.ts` mirrors it exactly. This lets external
  tools validate the JSON without the TypeScript toolchain.

- **Referential integrity check**: `validateEpicState` verifies that every dependency
  ID references an existing slice — guards against broken dependency graphs at
  parse time.

- **Separate lib / entry point**: Pure logic lives in `epic-status-lib.ts` (no I/O),
  the CLI entry owns file I/O and GitHub reconciliation. This pattern matches
  `apple-record-cli.ts` / `apple-calibration-lib.ts` and keeps tests fast.

- **slice:A0 marked `validated` in initial state**: The A0 slice is validated by the
  PR that creates these files — the commit evidence is the merge commit of this PR.
  The `commit_evidence` field will be filled by the Producer when the PR merges.

- **Slices B1, B2, B3 are computed-ready after A0 validates** (no cross-B dependencies):
  these three slices can be dispatched in parallel by the Producer. B2 and B3 do not
  depend on B1 (measurement tooling) because the tooling is used to _validate_ the
  item stats, not to define them.

## What's Next / Blockers

The Producer should, after this PR merges:

1. Update `slice:A0` `commit_evidence` field with the merge SHA.
2. Run `npm run epic:status -- floor-2-equipment --materialization-plan` to get
   the child issue queue.
3. Create child issues for slice:B1, slice:B2, and slice:B3 in parallel.
4. Record the `github_issue` numbers in `epic-state.json` (single coordinated update).
5. Dispatch the three child sessions.

No blockers.

## Retrospective

### Lessons Learned

- The `preserve-caught-error` ESLint rule requires `{ cause: err }` when wrapping a
  caught error in a new `Error()`. Always use `throw new Error('...', { cause: err })`.
- `match(/regex/)` return values are `string[] | null`, and individual captures are
  `string | undefined` — need explicit undefined checks for strict TypeScript.
- JSON schemas with `"$schema"` reference fields in the same doc need `"$schema":
{ "type": "string" }` in `additionalProperties: false` objects, or validation
  will reject the self-reference.

### Mistakes Made

- Initial implementation hardcoded `feat(floor2-equipment)` in the materialization
  plan template instead of using `state.epic_id`. Caught during local testing.
- First version of CLI args parsing had `args[0].startsWith('-')` with a possible
  undefined on `args[0]` — strict TypeScript caught it.

### Opportunities for Future Improvement

- The `--github --reconcile` mode currently uses `fetch` directly; it could be
  extracted to the shared GitHub-client pattern used elsewhere in the agent scripts.
- The `epic:status` CLI could be extended to support `--update-evidence --commit <sha>`
  to let the Producer write commit evidence back to the state file semi-automatically.
- A `docs:check` extension could validate every `epic-state.json` in
  `docs/knowledge/epics/` against the schema on each PR.
