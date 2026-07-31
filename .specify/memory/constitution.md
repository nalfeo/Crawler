# Crawler — Project Constitution

## Identity

Crawler is a crafting-focused vampire-survivors-like set inside a brutal intergalactic reality show dungeon. Built with Phaser 4 + bitecs ECS + TypeScript.

## Governing Principles

### 1. Agent = Model + Harness

The model provides reasoning. The harness is everything else: tools, memory, sandbox, context, gates, sensors, loops, policies. LLMs are for creative pursuits only. All enforcement is deterministic.

### 2. Lab-Gated Development + Real-Pipeline Wiring

No ECS system ships to production without a corresponding lab sandbox. Labs live in `src/labs/<system>-lab/`. Lab coverage is enforced by `scripts/agent/lab-gate-check.sh` (currently scoped to `src/core/systems`).

Lab-only proof is **insufficient** for wiring/behavior changes: any `*System` exported from `src/core/**` or `src/game/**` must also be referenced by a real runtime wiring site (`src/bootstrap/floor-main-scene-options.ts`, `src/core/simulation-core-step.ts`, `src/engine/sim/simulation-step.ts`, `src/game/ai/simulation-step.ts`, `src/game/ai/headless-runner.ts`) or explicitly allowlisted in `scripts/agent/health/orphaned-systems-lib.ts` with a reason. Enforced by `npm run check:wired-systems` (ADR 0039). See rule #15 in `AGENTS.md`.

### 3. Deterministic CI Only

No LLM-as-judge in CI. All gates are deterministic scripts with exit codes. The CI pipeline is ordered by speed — fast gates run first, fail fast.

### 4. Deterministic Game Logic

All game randomness uses `SeededRandom` — never `Math.random()`. All time uses delta/frameCount — never `Date.now()`. Same seed must produce identical game sequences.

### 5. ECS-Phaser Bridge Pattern

Game logic lives entirely in bitecs systems (pure functions). Phaser is a replaceable rendering layer. `src/core/` never imports from `src/engine/`.

### 6. Generated Content Load-Only; Deterministic AI Runtime

Two distinct AI layers coexist and must not be conflated:

- **LLM / Director-generated content** (Ollama, "The Director"), when implemented, runs **only during floor-load transitions** — never mid-gameplay. It must have static JSON fallbacks and be validated with Zod schemas.
- **Deterministic runtime AI** — headless simulation runners (`src/game/ai/headless-runner-cli.ts`, `simulation-step.ts`), behavior-tree kernels (`src/game/ai/behavior-tree.ts`), family-aware AI (`src/game/systems/familyFeudSystem.ts`), and win-rate sweeps (`ai:hill-climb`, `ai:winrate-sweep`, `ai:weapon-sweep`) — is a normal game system. It runs every frame, uses seeded randomness and delta/frame time, and must be validated through the real pipeline, not just labs.

Neither layer may call `Math.random()` or `Date.now()`.

### 7. Memory Governance

- Mandatory handoff files at session end
- ADR required for decisions affecting 2+ systems
- Promotion to Tier 1 (hot memory) requires evidence of 3+ sessions needing the knowledge
- Nothing is deleted — only archived

### 8. Coverage Requirements

- `src/core/` and `src/game/`: 90% line coverage target
- `src/shared/`: 90% target
- `src/engine/`: 50% target
- `src/labs/`: 30% target
- Overall: 80% target

These are aspirational per-layer targets. Mechanical enforcement currently uses per-file thresholds in `vitest.config.ts`; see `docs/agent-os/policies/ci-policy.md` for the gate stack and enforcement details.

### 9. Rapid Five-Level Build Growth

Equipment and other build progression must preserve Crawler's rapid
fragile-to-dominant power curve. For one fixed representative build cohort,
median aggregate realized DPS over committed deterministic encounter fixtures
must grow by **1.7x-2.3x every five player levels**.

The initial release gate evaluates level 1 -> 6 and level 6 -> 11 as independent
bands; both must pass. Results may be spiky for an individual build, encounter,
or seed, but neither cherry-picked weapons nor averaging one failing band into a
passing band may satisfy the principle. Later progression extends the same
five-level windows (11 -> 16, 16 -> 21, and so on) with new representative
fixtures; extending coverage never changes the 1.7x-2.3x target.

### 10. Hashimoto's Loop

Every agent failure becomes a permanent fix: observe → classify → decide fix type → implement → add regression test → audit. Never "fix the prompt" — encode rules as sensors.

### 11. Zero Cruft

Every test, lint, typecheck, and build failure encountered during a session must be fixed before the session ends — regardless of whether the agent caused it. There is no such thing as a "preexisting" or "unrelated" failure that is out of scope. Running the suite only to record a baseline of failures to ignore is waste; it compounds cruft across sessions and degrades future agent time.

### 12. AI Simulator Lab Compatibility

Every game system must be exercisable inside the AI simulator lab (`src/labs/ai-runner-lab/`). A system is not considered complete until the AI can drive it end-to-end without human input.

UX state — including menus, modals, HUD flags, conversation state, world-state strings, and any other player-facing control surface — must be discoverable and operable programmatically. Labs that host interactive UX must expose it via a well-known `window.__<camelCasedLabId>Debug()` snapshot function (following the pattern established in `AiRunnerDebugSnapshot` — e.g., `ai-runner-lab` → `window.__aiRunnerDebug()`) and, where mutation is needed, a `window.__<camelCasedLabId>Control` interface. These interfaces are debug-only and must never ship to the production build.

This means:

- No UX gate (modal, menu, dialog, lock) may be permanently impassable without a programmatic bypass.
- Every boolean or enum UX state must appear in the snapshot so the AI can observe it.
- Every user-triggerable action must have a corresponding programmatic entry point callable from the control interface.

CI enforcement: `scripts/agent/lab-gate-check.sh` currently enforces the system-→-lab coverage mapping for `src/core/systems`. The snapshot/control-interface contract above is a project rule verified today by tests and code review; a dedicated CI checker for `window.__<camelLabId>Debug()` / `Control` exports remains a TODO, and until it lands, PRs that add interactive UX labs must cite the snapshot + control functions in their description.

### 13. Observe Before Done (Real Artifact Validation)

For any change that adds/moves a system or alters runtime behavior, the "observe before done" note must name the **real pipeline artifact** the change was observed in — the game (`npm run dev`), the headless runner (`src/game/ai/headless-runner.ts`), or a win-rate gate — never a lab. Labs prove isolated correctness; they can never prove the real game or headless pipeline actually calls the system. This rule exists because `spawnerSystem` shipped fully inert — lab-proven, ADR'd, merged — yet never referenced by either real pipeline (ADR 0034 → ADR 0036).

### 14. Never Weaken Human Requirements to Pass a Gate

Explicit human requirements (from the user, spec, or ADR) are load-bearing. If a test, gate, or lint blocks progress, fix the code — never soften the requirement, lower a threshold, add a skip, or delete an assertion to make CI pass. If a requirement is genuinely wrong, raise it explicitly with the human and record the revision in a handoff or ADR.

### 15. Win-Rate, Not Cherry-Picked Seeds

Gameplay balance is tuned against **deterministic seed sweeps** (e.g. `ai:winrate-sweep`, headless Floor gates). The 90 %+ win-rate target is a rate over many seeds; never adjust code to rescue a specific seed at the expense of the aggregate rate. Governor/balance changes must cite the sweep before and after.

### 16. Apple-Scaled Review Harness

Before opening a PR that touches code, run the apple-scaled review harness and append the result to the review ledger (`scripts/agent/review/ledger.mjs`). Apple complexity is declared before writing code and scored at handoff (see `docs/agent-os/policies/complexity-policy.md` and `.github/skills/review-harness/SKILL.md`).

## Architectural Boundaries

- `src/core/` → must not import `src/engine/`, `src/game/`, or `src/labs/`
- `src/engine/` → must not import `src/game/` or `src/labs/`
- `src/game/` → must not import `src/engine/` or `src/labs/`
- `src/labs/` → unrestricted

## Non-Negotiable

- No `Math.random()` anywhere in game code
- No `eval()` or `Function()` constructors
- No secrets in source code
- No LLM calls in CI pipeline
- No Phaser imports in `src/core/`
- No skipping, ignoring, or deferring test/lint/build failures — fix every failure encountered
