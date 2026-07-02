# Session Handoff: Deterministic orphaned-system wiring guard (spawner inert-ship retro)

## Date

2026-07-02

## Persona(s) adopted

**Producer** — the task spanned static-analysis tooling, CI/verify wiring, cross-cutting
rule/doc changes, an ADR, and a review harness, so it needed the multi-layer coordinating
persona rather than a single specialist. No hand-off to a specialist was required; the work
was cohesive enough to execute directly under Producer.

## Routing verdict

✅ right persona — a process-fix retro that touches tooling + CI + rules + docs is exactly the
Producer's multi-layer remit.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 📉 Under — task was harder than expected: the code-review loop rejected the first
regex/comment-strip detection draft (string literals and URLs miscounted as references;
re-exports invisible) and forced a rewrite onto the TypeScript compiler API (AST), plus a second
round surfaced a fail-open + barrel-attribution fix. The extra rigor was correct, not scope creep.

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-guard-orphaned-systems.review-ledger.json`
Stages (3🍎 tier): plan_review ✅ · code_review ✅ (loop: R1 concerns → R2 concerns → R3 CLEAN)
`npm run review:ledger -- validate <path>` → ✅ valid 3-apple ledger.

Tier note: the review harness scales to the **declared** apple estimate (3🍎 → plan_review +
code_review loop; no dual-plan/multi-model). The actual came in at 4🍎, recorded above as an
overrun — it does not retroactively change the pre-code harness tier, and the creator/human
explicitly confirmed the 3🍎 tier.

## What Was Done

Investigated why `spawnerSystem` shipped fully inert (built, lab-proven, ADR 0034'd, merged — but
never called by either real pipeline, only force-called by `src/labs/spawner-lab/index.ts`), and
built a deterministic guard so the class of bug cannot recur. The code fix itself was PR #665
(ADR 0036) — this session is the **process fix**, not a duplicate of that wiring.

- **Guard (deterministic, no LLM — rule #2).** `scripts/agent/health/orphaned-systems-lib.ts`
  parses source with the TypeScript compiler API (AST) and enumerates every exported `*System`
  under `src/core/**` + `src/game/**` (covering `export function`, `export const`, and
  `export { … }` / `x as fooSystem` re-exports), then asserts each is referenced from one of five
  real wiring sites — as a direct call `fooSystem(world)` or a pipeline-array element/spread — or
  is on a structured `ALLOWLIST`. CLI `scripts/agent/health/orphaned-systems.ts`
  (`npm run check:wired-systems`) exits 0/1/2 and **fails closed** if zero systems are discovered.
  22 unit tests in `tests/unit/orphaned-systems-guard.test.ts`.
- **Wiring.** `package.json` (`check:wired-systems`), `scripts/agent/verify.sh` (step 5b), and a
  blocking step in the `check-format-and-labs` CI job.
- **Allowlist hygiene.** Structured entries (`reason` + `trackedIssue` + `owner`, all enforced);
  the guard also flags malformed entries and stale entries (`missing` = system gone, `redundant`
  = now wired). Two entries, each classified before allowlisting: `enemySpawnerSystem` (genuine
  lab/test-only helper — takes a `SpawnerConfig` arg, not a `(world)=>void` system) and
  `weaponEntitySystem` (a **latent never-wired feature** — same failure class as spawnerSystem;
  filed issue **#666** for a wire-or-delete decision rather than hiding it). Did **not** allowlist
  `spawnerSystem` (rule #12).
- **Rule strengthening (deliverable 3).** AGENTS.md rule #10 now states lab-only validation is
  insufficient for wiring/behavior changes and must name the real artifact; new rule #15 codifies
  wired-or-allowlisted. Mirrored in `.github/copilot-instructions.md`. Added a mandatory
  "Runtime / real-artifact observation" section to the handoff `TEMPLATE.md`.
- **ADR 0039** documents the guard, the 5-whys root cause, and alternatives.
- Corrected `docs/systems/03-weapons.md` (it falsely listed `weaponEntitySystem` as wired).

## Runtime / real-artifact observation

The guard itself is the artifact; its correctness was observed against the **real source tree**,
not a lab:

- **Before (old `main`, pre-#665 wiring):** `npm run check:wired-systems` → **exit 1**, flagging
  exactly `spawnerSystem` at `src/game/spawners/spawnerSystem.ts` (the real def, not the
  `src/game/index.ts` barrel). Reproduced the inert-ship bug deterministically.
- **After (rebased onto `main` with #665 merged):** same command → **exit 0**, "40 system(s)
  checked; all wired into a real pipeline or documented on the allowlist." The two allowlisted
  helpers are not flagged; the previously-orphaned `spawnerSystem` is now detected as wired via
  `src/bootstrap/floor-main-scene-options.ts` `preSystems` and `src/game/ai/simulation-step.ts`.

This before/after is the guard failing on the exact state that shipped the bug and passing once
the wiring lands — the "observe in the real artifact" the original session lacked.

## What's Next

- **#666**: decide wire-or-delete for the latent `weaponEntitySystem` multi-weapon-entity feature.
  When resolved, remove its allowlist entry (the guard will flag it as `redundant` once wired, or
  it disappears from the tree if deleted).
- Consider teaching `extractReferencedSystems` any _new_ wiring indirection (registry/builder) if a
  future pipeline stops using the direct-call / array-element forms, to avoid false orphans.

## Blockers

Resolved during the session: PR #665 was OPEN+BLOCKED at the start (so the guard correctly failed on
main), then **merged** at 17:13Z. The branch was fast-forwarded onto the new `main` (no file overlap),
after which the guard passes. No remaining blockers.

## Branch State

- Branch: `nalfeo-glowing-guacamole`
- All tests passing: yes (guard unit tests 22/22; typecheck + eslint clean; full `verify` — see below)
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

Guard telemetry captured via: none (`files/guard-telemetry.jsonl` not present this session)

## Test Results

- `npx vitest run tests/unit/orphaned-systems-guard.test.ts` → 22 passed.
- `npm run typecheck` → clean. `eslint` on changed files → clean.
- `npm run check:wired-systems` → exit 0 (post-rebase).
- `npm run verify` → see PR / final verify run.

## Key Decisions Made

- **AST over regex** for detection (review-forced): the `*System` naming convention is not enough;
  string/URL/comment/import false signals must be excluded structurally.
- **Fail closed** when zero systems are discovered — a vacuous pass would silently disable the guard.
- **Allowlist is tracked debt, not a mute button**: structured entries + malformed/stale checks +
  per-orphan classification (bug→file/wire, dead→delete, helper→allowlist). Never allowlist to go green.
- Harness tier keyed on the **declared** estimate (3🍎), with the actual 4🍎 recorded as an overrun.

## Retrospective

### Lessons Learned

- A lab **force-calls** the system under test, so a green lab can prove a system works in isolation
  but can NEVER prove the real game calls it. "Observe before done" must name the real artifact
  (game or headless pipeline), which is now codified in rule #10 + the handoff template.
- The repo has **two** hand-maintained sim pipelines (visual `src/engine/sim/simulation-step.ts`
  via `floor-main-scene-options.ts` `preSystems`; headless `src/game/ai/simulation-step.ts`), plus
  `headless-runner.ts` and `MainGameScene.ts` as additional wiring sites — a system must be wired in
  each relevant one. Missing either is exactly the gap that shipped spawnerSystem inert.
- TypeScript's compiler API (`ts.createSourceFile`, `forEachChild`) is already a dependency and is
  the right tool for this kind of lightweight static guard — no need for ts-morph/madge.

### Mistakes Made

- First detection draft used regex over comment-stripped text; the code-review loop caught that
  string literals and URLs produced false references and re-exports were invisible. Early signal:
  any "does this token appear in the file" check is inherently unsafe for wiring assertions — reach
  for the AST immediately when the answer must distinguish code from strings/comments.
- Initially created `plan.md` in the repo root instead of the session folder; moved it. Session
  artifacts belong under the session-state folder, not the worktree.

### Opportunities for Future Improvement

- The two sim pipelines being non-byte-identical (tracked in #663) is the structural root; a single
  source of truth for the system order would remove the "wire it in two places" hazard entirely.
- A companion guard could assert every system referenced by a wiring site actually exists / is
  imported, catching the inverse (dangling reference) class.
