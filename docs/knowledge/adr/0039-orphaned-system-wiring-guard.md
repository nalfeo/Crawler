# ADR 0039: Deterministic orphaned-system wiring guard

## Status

Accepted

> The live rule is now canonical in Constitution §2 plus the matching AGENTS /
> instructions text; this ADR is the rationale and implementation record for the
> guard itself.

## Date

2026-07-02

## Estimated Complexity

🍎 x 3 estimated → 🍎 x 4 actual (calibration verdict **under** — harder than
estimated). A single deterministic script plus its unit tests and wiring into
`verify`/CI, spanning a static-analysis lib, a CLI, docs/rule changes across
`AGENTS.md` + `.github/copilot-instructions.md` + the handoff template, and
proven to fail on the real pre-fix state. The extra apple came from review: a
first regex/comment-strip draft was rejected (string literals counted as
references, URLs truncated real references, re-exports were invisible), forcing a
rewrite onto the TypeScript compiler API (AST).

Because the honest actual is 4🍎, the review harness was run at the full **4-apple
tier**: `plan_review` + `dual_plan_synthesis` (two plans on distinct models —
gpt-5.4 and gemini-3.1-pro — synthesized/audited by a claude-opus-4.8 judge) +
`code_review` + `multi_model_review` (two distinct-model reviewers looped to
clean, adjudicated by claude-opus-4.8). The guard whose entire purpose is
preventing under-validated features from shipping is itself validated at the
maximum tier its complexity warrants. The base guard shipped in PR #667 (ledger
`2026-07-02-guard-orphaned-systems.review-ledger.json`, 3-apple, merged before the
harness was fully escalated); the 4-apple harness and the dangerous-direction
hardening it surfaced landed as a follow-up (ledger
`docs/knowledge/review-ledgers/2026-07-02-guard-orphaned-systems-hardening.review-ledger.json`).

## Context

The generic spawner mob-type feature (`spawnerSystem` — trickle children,
`spawnerPulse` world VFX, `SpawnAnim` child pop-in) was built, lab-proven,
ADR'd (ADR 0034), handed off, and merged — but it was **never called** in either
real game pipeline. It ran only inside `src/labs/spawner-lab/index.ts`, which
imports and directly invokes `spawnerSystem(this.world)`. In the actual game and
the headless runner the entire feature shipped turned off. PR #665 (ADR 0036 on
that branch) fixed the wiring; this ADR is the **process fix** so the class of
bug cannot ship again.

Root cause (5-whys):

1. **Why did an inert feature ship?** Nothing referenced `spawnerSystem` from a
   real pipeline entry point.
2. **Why didn't validation catch it?** "Observe before done" (rule #10) was
   satisfied only in `spawner-lab`.
3. **Why was a lab sufficient to look green?** A lab **force-calls** the system
   under test, so a green lab proves the system works in isolation but can NEVER
   prove the real game calls it. ADR 0034 decision step 5 explicitly chose to
   "validate the behavior with gameplay tests plus the existing `spawner-lab`
   runtime flow rather than adding a new lab."
4. **Why did review/handoff/merge not flag the gap?** There was no deterministic
   check asserting that every exported system is referenced by a real pipeline,
   and the rules did not distinguish lab validation from real-artifact
   validation for wiring/behavior changes.
5. **Why is the gap structural?** There are **two** hand-maintained simulation
   pipelines — visual (`src/engine/sim/simulation-step.ts`, wired via
   `src/bootstrap/floor-main-scene-options.ts` `preSystems`) and headless
   (`src/game/ai/simulation-step.ts`, run by the win-rate gate and
   `headless-runner`) — that are not byte-identical (tracked in issue #663).
   Wiring a new system means editing both by hand, and there was no guard that
   both edits happened.

## Decision

Add a **deterministic architecture guard** (project rule #2: no LLM-as-judge —
a script with an exit code) that catches orphaned game systems, and strengthen
the rules/templates so lab-only validation is explicitly insufficient for
wiring/behavior changes.

1. **Static guard.** `scripts/agent/health/orphaned-systems-lib.ts` (pure,
   unit-testable logic) parses each source file with the **TypeScript compiler
   API** (`ts.createSourceFile`) and enumerates every exported `*System`
   definition under `src/core/**` and `src/game/**` — covering
   `export function`, `export const`, `export { … }` / `export { x as
fooSystem }` re-export forms, and `export default fooSystem` / `export =
   fooSystem` assignment forms (an assignment of a _local_ declaration is
   attributed to that file, not treated as a barrel re-export, so a system
   shipped via a default export can't slip past discovery). It then asserts each
   is referenced from a sim-side/shared
   pipeline wiring site — `src/bootstrap/floor-main-scene-options.ts`,
   `src/core/simulation-core-step.ts`, `src/engine/sim/simulation-step.ts`,
   `src/game/ai/simulation-step.ts`, or `src/game/ai/headless-runner.ts` — or
   is on an explicit, structured `ALLOWLIST` (for systems intentionally not-yet
   wired or non-pipeline helpers). A reference counts **only** when it is one of
   the two real wiring forms: a direct call (`fooSystem(world)`, including an
   invoked nullish fallback such as `(override ?? fooSystem)(world)`) or a
   pipeline-array element/spread (`preSystems: [fooSystem, …]`). Because
   detection is AST-based, identifiers inside imports, strings, comments, type
   positions, and bare assignments are never miscounted — the exact false
   signals (`const note = "spawnerSystem"`, `http://…/spawnerSystem`) that a
   regex draft got wrong. Labs and tests are deliberately NOT wiring sites — a
   lab reference is exactly the false signal this guard exists to reject. The
   guard also flags **malformed allowlist entries** (missing `reason`,
   `trackedIssue`, or `owner`) and **stale allowlist entries** — `missing` (the
   name no longer exists) or `redundant` (now actually wired) — so the allowlist
   cannot rot into a silent mute button.

   **2026-07-31 sim-side reachability ratchet.** `MainGameScene.ts` is no longer
   an independent wiring witness: a scene-only call can be absent from the
   AI/headless simulation. The shared bootstrap options remain a witness because
   `headless-runner.ts` consumes `createFloorMainSceneOptions()` and passes its
   canonical `preSystems`/`postSystems` into the headless step. Both sim wrappers
   remain valid witnesses by explicit maintainer decision. This is intentionally
   a sim-side-only rule; a stronger player/UI-observability witness requirement
   was considered and declined. The current tree measures 49 exported systems:
   46 sim-side reachable, 3 already allowlisted, and 0 genuine failures. The
   nullish-callee form above is required for `fovSystem`, which the shared core
   step executes as `(options.runFovSystem ?? fovSystem)(world)`.

2. **CLI.** `scripts/agent/health/orphaned-systems.ts` runs the lib via the
   shared `Report` helper and exits 0 (all wired/allowlisted), 1 (orphan, or a
   malformed/stale allowlist entry, or a duplicate `*System` declaration), or 2
   (crash). It **fails closed** if discovery returns zero systems or fewer than
   `MIN_EXPECTED_SYSTEMS` (a partial/broken scan must not pass vacuously), and
   flags any `*System` name declared in two source files (name-based wiring would
   otherwise mark both wired and hide an orphaned twin). Exposed as
   `npm run check:wired-systems`.
3. **Enforcement.** Wired into `scripts/agent/verify.sh` (step 5b) and the
   blocking `check-format-and-labs` CI job (gated into the merge-gate), alongside
   the existing lab-gate and guard-ledger checks. Unit tests in
   `tests/unit/orphaned-systems-guard.test.ts` prove it fails on an unwired
   synthetic system, passes when wired, reject the string/URL/import/comment
   false signals, detect re-export defs, cover malformed + missing + redundant
   allowlist findings, and keep the real-tree allowlist honest.
4. **Rule/template strengthening.** Rule #10 ("observe before done") now states
   lab-only validation is insufficient for wiring/behavior changes and the note
   MUST name the real artifact (game via `npm run dev`, or a headless
   pipeline / win-rate gate). A new rule #15 codifies the wired-or-allowlisted
   requirement. The handoff `TEMPLATE.md` gains a mandatory "Runtime /
   real-artifact observation" section, and `.github/copilot-instructions.md`
   gains a matching Critical Rules bullet.

The allowlist starts with two entries surfaced by the guard on the real tree,
each a **structured entry** (`reason` + `trackedIssue` + `owner`, all required):
`enemySpawnerSystem` (a lab/test-only helper that takes a `SpawnerConfig` arg and
is not a `(world) => void` pipeline system) and `weaponEntitySystem` (has unit
coverage but no runtime wiring — a real latent orphan, allowlisted and tracked in
issue #666 rather than hidden). Each was classified before allowlisting (latent
bug → file/wire, dead code → delete, genuine helper → allowlist) rather than
allowlisted "because it isn't wired." We deliberately did **not** allowlist
`spawnerSystem`: doing so to go green would defeat the guard and violate rule #12.

## Consequences

### Positive

- The exact failure that shipped `spawnerSystem` inert is now impossible to merge
  without either wiring the system or making a documented, reviewed allowlist
  exception.
- The guard is fast, deterministic, and dependency-free — it parses with the
  `typescript` compiler API already in the toolchain (no new dependency), so it
  fits the fast `check-format-and-labs` job and local `verify`.
- The allowlist makes the currently-orphaned `weaponEntitySystem` visible and
  tracked instead of silently unnoticed.
- Rule/template changes generalize the lesson beyond spawners: any future wiring
  change must name a real artifact.

### Negative

- AST matching follows only two structural wiring forms (direct call, including
  an invoked nullish fallback, and
  pipeline-array element/spread). A system wired via some other indirection (a
  registry, a builder that receives system refs by another shape) would be a
  false positive until either `extractReferencedSystems` learns that form or the
  system is allowlisted. Dynamic/aliased references are likewise out of scope.
  The `*System` naming convention and the two-form contract keep this low-risk.
- **Trusted-oracle limitation (documented + pinned).** A reference counts if it
  appears in a `WIRING_SITES` file in one of the two forms — the guard does not
  prove the enclosing array/function is itself reached at runtime. A dead
  reference inside a wiring file (`const unused = [fooSystem]`, or a call inside
  an unused local helper) would mark `fooSystem` wired. Tightening this by
  parent-context would break the legitimate direct-call form used in trusted
  sim-side files, so it is accepted, documented in the lib,
  and pinned by negative regression tests. Destructured registry exports
  (`export const { fooSystem } = …`) are likewise an accepted blind spot — ECS
  systems are standalone functions, never destructured.
- One more gate to keep green. Genuinely not-yet-wired systems require a
  structured allowlist entry (reason + trackedIssue + owner).

### Risks

- **Allowlist abuse** — an agent could silence the guard by allowlisting a system
  it should have wired. Mitigated by requiring a structured entry (reason +
  trackedIssue + owner, enforced), the malformed- and stale-entry checks,
  review-harness scrutiny, and rules #12/#15 explicitly forbidding go-green
  allowlisting.
- **Wiring-site drift** — if a new sim-side/shared pipeline entry point is added, it must be
  added to `WIRING_SITES` or legitimately-wired systems will false-positive.
  Documented in the lib.

## Alternatives Considered

- **Regex / comment-stripped token matching.** The first draft. Rejected in
  review: string literals and URLs produced false references and re-exports were
  invisible. Replaced by the AST approach above, which is precise without a new
  dependency (`typescript` is already in the toolchain).
- **Heavier type-graph analysis (ts-morph / madge).** More precise for dynamic
  or aliased references but pulls a heavier dependency into a fast gate. The
  `*System` naming convention plus the compiler-API parse make the lightweight
  approach sufficient; revisit if indirection-based false positives appear.
- **Require a dedicated lab-vs-real integration test per system.** Higher-value
  but far more expensive per system and does not structurally prevent the
  "forgot to wire" gap the way a whole-tree enumeration does. The guard and
  richer integration tests are complementary.
- **Rule/handoff changes only (no script).** Rejected: the original failure
  already passed a human/agent workflow with rules in place. Only a deterministic
  gate (rule #2) reliably prevents recurrence.
- **Allowlist `spawnerSystem` to make this PR green while #665 is unmerged.**
  Rejected outright — it would defeat the guard's purpose and violate rule #12.
  The guard correctly fails until the wiring lands on the base branch.
