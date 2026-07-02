# Session Handoff: Orphaned-system guard hardening + 4-apple harness completion

Follow-up to PR #667 (the deterministic orphaned-system wiring guard). #667 was
squash-merged by auto-merge while still at the 3-apple review tier; this session
completes the **full 4-apple review harness** the guard's honest complexity
warranted and lands the dangerous-direction (false-clean) hardening that the two
extra harness stages surfaced.

## Persona / Routing

Producer. The base guard is a cross-cutting process/tooling change; this follow-up
is a focused hardening pass driven by the escalated harness, executed directly.

## Apples

Estimated: 🍎 x 4 <!-- the review that was owed: dual_plan_synthesis + multi_model_review -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — the escalation to the 4-apple tier and the hardening it
surfaced were exactly the owed rigor. The base guard (PR #667) recorded estimated
3 / actual 4 as its calibration signal; this follow-up is the harness completion,
run and recorded at the full 4-apple tier.

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-guard-orphaned-systems-hardening.review-ledger.json`
Stages (**4🍎 tier**): plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate <path>` → ✅ valid 4-apple ledger.

- **plan_review** — separate-model (gpt-5.4): 4 concerns → 4 resolved (AST rewrite,
  allowlist-in-CLI, structured allowlist, weapons doc fix). Carried from the base guard.
- **dual_plan_synthesis** — two plans on DISTINCT models (gpt-5.4 + gemini-3.1-pro),
  synthesized/audited by a claude-opus-4.8 judge. Both planners independently chose the
  TS compiler API; the judge adopted Plan A's hermetic per-file `createSourceFile`
  backbone and flagged three dangerous-direction hardening items — all implemented here.
- **code_review** — single-model loop (gpt-5.4): R1 concerns → R2 concerns → R3 CLEAN.
- **multi_model_review** — two DISTINCT-model reviewers (gpt-5.4 + gemini-3.1-pro),
  adjudicated by claude-opus-4.8, looped to clean: R1 surfaced the export-assignment and
  incidental-reference false-clean holes; R2 CLEAN after fixes (gemini clean; gpt-5.4's
  sole round-2 Blocking — default-export of a local decl misclassified as a re-export —
  was fixed and re-verified).

## What Was Done

Landed the dangerous-direction (false-clean) hardening that the two extra 4-apple
harness stages surfaced on the base guard from PR #667:

- **Export-assignment detection.** `extractSystemDefs` now handles
  `export default fooSystem` / `export = fooSystem`. Critically, an assignment of a
  **local declaration** is attributed to that file as a `declaration` (not a barrel
  re-export), so a system shipped via a default export can't slip past discovery, and
  both duplicate detection and concrete-file attribution keep working. A forwarded
  (imported) symbol is still a `reexport`. `export default function fooSystem(){}` is
  caught by the existing function-declaration branch.
- **Duplicate-declaration detection.** New `findDuplicateSystemDeclarations` +
  CLI failure: a `*System` name declared in two source files would otherwise mark both
  wired by name and hide an orphaned twin. Declaration-kind only (barrel re-exports
  excluded); `.test`/`.spec` files skipped; deterministic output.
- **Partial-scan floor.** `MIN_EXPECTED_SYSTEMS = 10`; the CLI fails closed if fewer
  systems are discovered — a broken/partial scan must not pass vacuously.
- **Documented + pinned limitation.** An incidental reference inside a trusted
  `WIRING_SITES` file counts as wired (the guard does not prove the enclosing
  array/function is runtime-reached). Tightening parent-context would break the
  legitimate direct-call form in `MainGameScene`/`headless-runner`, so it is accepted,
  documented in the lib, and pinned by negative regression tests. Destructured registry
  exports noted as an accepted blind spot (ECS systems are standalone functions).

ADR 0039 updated to reflect the escalation and the new hardening. The base guard's
own artifacts (PR #667's 3-apple ledger, handoff, and apple JSON) are left untouched —
this follow-up carries its own new-slug handoff, ledger, and apple record.

## Files Touched

- `scripts/agent/health/orphaned-systems-lib.ts` — export-assignment detection
  (`locallyDeclared`/`exportAssignedNames`), `MIN_EXPECTED_SYSTEMS`,
  `findDuplicateSystemDeclarations` + `DuplicateSystemFinding`, expanded doc blocks.
- `scripts/agent/health/orphaned-systems.ts` — floor + duplicate fail-closed branches.
- `tests/unit/orphaned-systems-guard.test.ts` — export-assignment classification,
  duplicate-declaration cases (incl. duplicate default-exports), floor real-tree
  assertion, negative-regression pin for the incidental-reference limitation. 31 tests.
- `docs/knowledge/adr/0039-orphaned-system-wiring-guard.md` — escalation + hardening.
- `docs/knowledge/metrics/guard-telemetry/2026-07-02-guard-orphaned-systems.json` — capture.
- New: this handoff, the 4-apple hardening ledger, the hardening apple JSON.

## Test Results

- `npx vitest run tests/unit/orphaned-systems-guard.test.ts` → 31 passed.
- `npm run typecheck` → clean. `eslint` on changed files → clean.
- `npm run check:wired-systems` → exit 0 (40 systems, all wired/allowlisted, no
  duplicates, count ≥ `MIN_EXPECTED_SYSTEMS`).
- `npm run verify` → full verification passed (build + ledger guard + all projects).

## Observe-before-done (real artifact)

The guard's own end-to-end proof was captured on the base PR #667: it exited **1** on
the pre-#665 state (spawnerSystem unwired) and **0** once the real wiring landed on
main — with NO allowlist entry for spawnerSystem. This follow-up re-verifies the guard
still exits 0 on current main after the hardening, and the new tests pin the specific
false-clean holes the harness surfaced (export-assignment, duplicate-name,
incidental-reference).

## Key Decisions Made

- **Local-declaration export-assignments are declarations, not re-exports** — required
  for duplicate detection and concrete-file attribution to work (round-2 Blocking fix).
- **Fail closed below `MIN_EXPECTED_SYSTEMS`** — a partial scan must not pass vacuously.
- **Document + pin, don't over-tighten** — the incidental-reference-in-wiring-file
  limitation is accepted because tightening it would break the legitimate direct-call
  wiring form; negative regression tests lock the behavior.
- **Do not rewrite #667's merged records** — this follow-up ships its own new-slug
  handoff/ledger/apple JSON rather than editing the merged PR's artifacts.

## Recommended Next Steps

- None blocking. If a future system is wired via a registry/builder shape the two
  structural forms don't cover, extend `extractReferencedSystems` or allowlist with a
  tracked issue (never allowlist to go green — rule #12).
- `weaponEntitySystem` remains allowlisted and tracked in issue #666 (wire-or-YAGNI is
  a product call, out of scope here).
