# Session Handoff: Floor 3 Guardian/Support AI personas

## Date

2026-08-22

## Persona

Game AI Engineer (with Content Designer scoping for Floor 3 canon)

## Systems touched

ai-behavior-tree, enemies

## Apples

3🍎 exact — estimated 3, actual 3. Medium runtime AI slice with tests, lab observation, review ledger, and one historical ledger repair required by PR prereqs.

## What Was Done

Implemented the next incomplete Floor 3 Companion League slice from `.specify/specs/floor3-companion-league.md`: **Slice 4 — `GUARDIAN` and `SUPPORT` AI personas**.

- `src/game/enemyAISystem.ts`
  - Added append-only `AI_TYPE.GUARDIAN = 4` and `AI_TYPE.SUPPORT = 5`, preserving existing ordinals (`LEAPER` remains `3` for `dropSystem` compatibility).
  - Added Guardian movement: closes from outside guard distance, then holds space at a short frontline radius.
  - Added Support movement: deterministic standoff/retreat behavior using `attackRange` as the preferred band when present.
  - Kept Support movement-only for this slice by suppressing projectile firing with an in-code note that the later Kindler support-ability slice should remove/replace that exclusion.
  - Added path-driven support behavior so navigator personas use traversable targets for approach/retreat instead of only the no-map legacy branch.
- `src/labs/floor3-companion-lab/index.ts`
  - Lab now runs the real `companionAISystem → enemyAISystem → movementSystem` pipeline instead of only printing prepass decisions.
  - Added a Guardian/Support/Chase selector and displays position delta + velocity for direct observation.
- Tests:
  - `tests/game/enemy-ai.test.ts` covers Guardian hold/close, Support retreat/hold/no-projectile, and pathing Support retreat/no-projectile.
  - `tests/unit/floor3-species-roster.test.ts` pins Floor 3 style mapping to the newly real `AI_TYPE` ordinals.
- Docs/harness:
  - Updated `.specify/specs/floor3-companion-league.md` status/table to reflect current slices 1–4 implementation state.
  - Added/validated `docs/knowledge/review-ledgers/2026-08-21-floor3-ai-personas.review-ledger.json`.
  - Recorded apple metrics in `docs/knowledge/metrics/apples/2026-08-22-floor3-ai-personas.json`.
  - Repaired the pre-existing incomplete historical ledger `docs/knowledge/review-ledgers/2026-08-21-floor2-wiggle-stuck-repair.review-ledger.json`, which blocked `npm run verify:pr-prereqs` after sync.

## Validation

- Preflight: `bash scripts/agent/preflight.sh` — passed.
- Targeted tests:
  - `npm test -- tests/game/enemy-ai.test.ts tests/unit/floor3-species-roster.test.ts tests/ecs/companion-ai-system.test.ts` — 64 passed.
  - Re-ran after pre-publish sync — 64 passed.
  - `npm test -- tests/game/enemy-ai.test.ts` after code-review comment fix — 48 passed.
- Type/format/guards:
  - `npm run typecheck` — passed.
  - `npm run format:check` — passed.
  - `npm run check:wired-systems` — passed, 0 blocking.
  - `npm run verify:fast` — passed (144 files / 2368 tests in changed-test step; guard checks green/non-blocking).
  - `npm run verify:pr-prereqs` — passed after repairing the historical Floor 2 ledger.
- Review/security:
  - Required plan review: `gpt-5.4` rubber-duck, approved with changes; all 6 concerns resolved in the plan.
  - Required code-review loop: `claude-sonnet-4.6` code-review found 2 concerns; valid Support-comment concern addressed, process concern resolved by completing ledger stages.
  - Independent grade: `gemini-3.1-pro-preview`, pass, all criteria 5/5.
  - Native `code_review` tool found one concern about Support standoff oscillation; assessed false positive because exact standoff already holds (`>` approach and `<` retreat), matching the path helper. No code change needed.
  - `codeql_checker` — 0 alerts; JavaScript analysis reported database-size skip.
  - Secret scans — no secrets in changed files.

## Runtime / observe-before-done evidence

Before this slice, Floor 3 style data already named `GUARDIAN` and `SUPPORT`, but the runtime AI enum had no corresponding personas, so those styles had no real game-layer behavior. After the slice, deterministic tests exercise the real pipeline (`enemyAISystem` and `companionAISystem → enemyAISystem → movementSystem`) for both personas. The Floor 3 companion lab now exposes the same pipeline with visible position/velocity deltas for Guardian and Support.

## Key Decisions Made

- Kept `GUARDIAN`/`SUPPORT` inside the existing `AI_TYPE`/`enemyAISystem` path instead of adding a parallel Floor-3-only AI stack.
- Appended enum ordinals only; did not renumber existing AI types.
- Kept Support movement-only until the later Kindler ability/combat payload slice so this PR does not accidentally invent healing/buff mechanics.
- Used the existing Floor 3 companion lab rather than adding a second lab, because the current lab already owns the companion prepass seam and could be upgraded to run the real pipeline.

## What's Next / Blockers

- Next Floor 3 slice per spec is **Slice 5 — per-creature leveling + evolution + abilities**. That is where Support/Kindler should gain an actual attack/buff payload and the temporary projectile exclusion should be revisited.
- No blockers from this session.

## Retrospective

### Lessons Learned

- The spec header was stale: it claimed only slices 1–2 landed, but current main already had the Slice 3 component/prepass/lab shape. Inspect source before blindly following the status line.
- `verify:pr-prereqs` validates all present ledgers, not just the current session ledger; a pre-existing incomplete historical ledger can block unrelated PRs.

### Mistakes Made

- The first issue-plan reply was intentionally broad because it was posted before enough repo inspection. I posted a refined issue reply before coding once source inspection showed Slice 4 was the correct next slice.
- `review:grade -- record` can only bind the current `HEAD`, so repairing a historical ledger required recording the independent grade through `review:ledger stage` after an actual separate-model review of the historical commit.

### Opportunities for Future Improvement

- Consider adding a deterministic script that keeps the Floor 3 spec status line in sync with landed slice handoffs or source markers, so it cannot drift behind implementation again.
