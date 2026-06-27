# Crawler — Project Constitution

## Identity

Crawler is a crafting-focused vampire-survivors-like set inside a brutal intergalactic reality show dungeon. Built with Phaser 4 + bitecs ECS + TypeScript.

## Governing Principles

### 1. Agent = Model + Harness

The model provides reasoning. The harness is everything else: tools, memory, sandbox, context, gates, sensors, loops, policies. LLMs are for creative pursuits only. All enforcement is deterministic.

### 2. Lab-Gated Development

No ECS system ships to production without a corresponding lab sandbox. Labs live in `src/labs/<system>-lab/`. This is enforced by CI, not by instructions alone.

### 3. Deterministic CI Only

No LLM-as-judge in CI. All gates are deterministic scripts with exit codes. The CI pipeline is ordered by speed — fast gates run first, fail fast.

### 4. Deterministic Game Logic

All game randomness uses `SeededRandom` — never `Math.random()`. All time uses delta/frameCount — never `Date.now()`. Same seed must produce identical game sequences.

### 5. ECS-Phaser Bridge Pattern

Game logic lives entirely in bitecs systems (pure functions). Phaser is a replaceable rendering layer. `src/core/` never imports from `src/engine/`.

### 6. AI Content During Load Only

Ollama (The Director) generates content during floor-load transitions. Never mid-gameplay. Always provide static JSON fallbacks. Validate with Zod schemas.

### 7. Memory Governance

- Mandatory handoff files at session end
- ADR required for decisions affecting 2+ systems
- Promotion to Tier 1 (hot memory) requires evidence of 3+ sessions needing the knowledge
- Nothing is deleted — only archived

### 8. Conventional Commits

Use Conventional Commit prefixes enforced by commitlint: `feat:`, `fix:`, `chore:`, `docs:`, `lab:`, `refactor:`, `test:`, `perf:`, `ci:`, `build:`, `revert:`. CI enforces commit format.

### 9. Coverage Requirements

- `src/core/` and `src/game/`: 90% line coverage target
- `src/shared/`: 90% target
- `src/engine/`: 50% target
- `src/labs/`: 30% target
- Overall: 80% target

These are aspirational per-layer targets. Mechanical enforcement currently uses per-file thresholds in `vitest.config.ts`; see `docs/agent-os/policies/ci-policy.md` for the gate stack and enforcement details.

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

CI enforcement: the lab-gate check (`scripts/agent/lab-gate-check.sh`) must verify that any lab hosting interactive UX exports both a snapshot and a control interface.

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
