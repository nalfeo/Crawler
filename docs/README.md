# Crawler Documentation Hub

Crawler is an agent-driven, crafting-focused vampire-survivors-like set in a
reality-show dungeon (Phaser 4 rendering · bitecs 0.4 ECS · TypeScript strict).
This is the map of all project documentation and the **source-of-truth registry**
for governance rules that appear in more than one place.

> New here? Read [`AGENTS.md`](../AGENTS.md) → run `bash scripts/agent/preflight.sh`
> → pick a [persona](agent-os/personas/README.md) → skim
> [`architecture.md`](architecture.md).

---

## Documentation map

| Area                      | Where                                                                                | What it is                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Architecture overview** | [`architecture.md`](architecture.md)                                                 | Layer model, the full systems catalogue, the update pipeline, planned work. Start here for "how the code fits together."                                                             |
| **System docs**           | [`systems/`](systems/)                                                               | Narrative/onboarding view of each subsystem (`01-movement-input` … `09-floor2-family-systems`).                                                                                      |
| **Specs**                 | [`../.specify/specs/README.md`](../.specify/specs/README.md)                         | Durable per-system contracts + the missing-spec backlog.                                                                                                                             |
| **ADRs**                  | [`knowledge/adr/README.md`](knowledge/adr/README.md)                                 | Architecture Decision Records (71 files, latest `0043`) with thematic + by-number indexes and the numbering policy.                                                                  |
| **Constitution**          | [`../.specify/memory/constitution.md`](../.specify/memory/constitution.md)           | The non-negotiable project principles.                                                                                                                                               |
| **Personas**              | [`agent-os/personas/README.md`](agent-os/personas/README.md)                         | Agent roles + the routing matrix (default **Producer**).                                                                                                                             |
| **Policies**              | [`agent-os/policies/`](agent-os/policies/)                                           | CI, complexity (apples), review harness, lab-gate, memory/handoff, telemetry.                                                                                                        |
| **Guides**                | [`guides/`](guides/)                                                                 | How-to: [contributing](guides/contributing.md), [lab authoring](guides/lab-authoring.md), [system authoring](guides/system-authoring.md).                                            |
| **Game design**           | [`knowledge/game-design/`](knowledge/game-design/)                                   | [GDD](knowledge/game-design/game-design-document.md), [lore bible](knowledge/game-design/lore-bible.md), [art-style guide](knowledge/game-design/art-style-guide.md).                |
| **Handoffs**              | [`knowledge/handoffs/`](knowledge/handoffs/)                                         | Per-session context to read before starting.                                                                                                                                         |
| **AI pathing rework**     | [`knowledge/ai-pathing-rework-slicemap.md`](knowledge/ai-pathing-rework-slicemap.md) | Live slice-map + source-of-truth for the navmesh / danger-reward / seam AI rework (S0–S4b): the two-axis design, the LEGACY-default invariants, and the human-gated graduation gate. |
| **Metrics**               | [`knowledge/metrics/`](knowledge/metrics/)                                           | Health metrics + apple-complexity calibration data.                                                                                                                                  |
| **Instruction files**     | [`../.github/instructions/`](../.github/instructions/)                               | Path-scoped (`applyTo:`) rules auto-loaded when editing matching files.                                                                                                              |

### How the layers relate

```
Game Design Document  (what the game is)
        │
        ▼
   Specs (.specify/specs)      ← durable contract per system
        │   ▲
        │   │ amended by
        ▼   │
      ADRs (knowledge/adr)     ← one decision each
        │
        ▼
   architecture.md + systems/  ← narrative map of the implementation
        │
        ▼
        Code (src/)            ← the ground truth
```

When two of these disagree, **code wins**; fix the doc and note the
reconciliation.

---

## Governance source-of-truth registry

Several rules are intentionally repeated across entry-point files (`AGENTS.md`,
`.github/copilot-instructions.md`, the constitution, instruction files) so an
agent sees them in context. To stop those copies from drifting, this table names
the **one canonical definition** for each rule. **Edit the canonical file first;**
treat the others as pointers.

| Rule / topic                                  | Canonical source                                                                                                                        | Also restated in (keep in sync)                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Request Intake (interview-first, bounded ask) | `AGENTS.md` › Request Intake                                                                                                            | `.github/copilot-instructions.md`                                                                                             |
| Conventional-commit types                     | `commitlint.config.cjs` + [`ci-policy.md`](agent-os/policies/ci-policy.md)                                                              | constitution, `AGENTS.md`, `.github/copilot-instructions.md`, [contributing](guides/contributing.md)                          |
| Layer / import boundaries                     | ESLint config + [`.github/instructions/`](../.github/instructions/)                                                                     | [`architecture.md`](architecture.md), `AGENTS.md`, `.github/copilot-instructions.md`, constitution                            |
| `SeededRandom` only (no `Math.random`)        | constitution + `copilot-guards` extension                                                                                               | instruction files, `AGENTS.md`, `.github/copilot-instructions.md`                                                             |
| No `Date.now()` in sim (pass delta/frame)     | constitution + `copilot-guards` extension                                                                                               | instruction files, `AGENTS.md`                                                                                                |
| Apple complexity workflow                     | [`complexity-policy.md`](agent-os/policies/complexity-policy.md)                                                                        | `AGENTS.md`, `.github/copilot-instructions.md`                                                                                |
| Review harness (apple-scaled review + ledger) | [`review-harness-policy.md`](agent-os/policies/review-harness-policy.md) + `scripts/agent/review/ledger.mjs`                            | [`review-harness` skill](../.github/skills/review-harness/SKILL.md), personas, `AGENTS.md`, `.github/copilot-instructions.md` |
| PR / diff review contract                     | [`../.github/instructions/review.instructions.md`](../.github/instructions/review.instructions.md)                                      | [`code-review` skill](../.github/skills/code-review/SKILL.md), `.github/copilot-instructions.md`                              |
| Lab-gating (every system needs a lab)         | [`lab-gate-policy.md`](agent-os/policies/lab-gate-policy.md) + [ADR 0002](knowledge/adr/0002-lab-gated-development.md)                  | [labs instructions](../.github/instructions/labs.instructions.md), `AGENTS.md`, constitution                                  |
| Handoff required before session end           | [`memory-policy.md`](agent-os/policies/memory-policy.md)                                                                                | `AGENTS.md`, `.github/copilot-instructions.md`                                                                                |
| CI gates & `verify` / `verify:fast`           | [`ci-policy.md`](agent-os/policies/ci-policy.md) + `package.json`                                                                       | `AGENTS.md`, `.github/copilot-instructions.md`                                                                                |
| Session kickoff / closeout checklist          | `AGENTS.md` › Quick Start + [`memory-policy.md`](agent-os/policies/memory-policy.md) + [`ci-policy.md`](agent-os/policies/ci-policy.md) | [`session-kickoff-closeout` skill](../.github/skills/session-kickoff-closeout/SKILL.md)                                       |
| Merge policy (`gh pr merge --auto --squash`)  | `AGENTS.md` › Merge Policy                                                                                                              | `.github/copilot-instructions.md`                                                                                             |
| Resolving review threads (`✅ Addressed`)     | `AGENTS.md` › Resolving addressed review comments                                                                                       | `.github/copilot-instructions.md`                                                                                             |
| ADR required (2+ systems) + numbering         | [ADR index](knowledge/adr/README.md) + constitution                                                                                     | `AGENTS.md`, `.github/copilot-instructions.md`                                                                                |
| Persona routing                               | [personas README](agent-os/personas/README.md)                                                                                          | `AGENTS.md`, `.github/copilot-instructions.md`                                                                                |

---

## "Where do I put …?"

| You are writing…                       | Put it in                                                                |
| -------------------------------------- | ------------------------------------------------------------------------ |
| A single decision affecting 2+ systems | a new [ADR](knowledge/adr/README.md) (`NNNN-slug.md`, next # = **0044**) |
| The durable contract for a system      | a [spec](../.specify/specs/README.md) (`.specify/specs/<system>.md`)     |
| Onboarding narrative for a subsystem   | a [system doc](systems/) (`docs/systems/NN-name.md`)                     |
| Path-scoped coding rules               | a [`*.instructions.md`](../.github/instructions/) file with `applyTo:`   |
| End-of-session context                 | a [handoff](knowledge/handoffs/) (`YYYY-MM-DD-<slug>.md`)                |
| A reusable how-to                      | a [guide](guides/)                                                       |

---

## Validating docs

```bash
npm run docs:check     # path checks, ADR consistency, persona shape, README commands, handoff/telemetry sweeps
npm run verify:fast    # typecheck + lint + unit tests (~30s)
npm run verify         # full suite before committing (~3min)
```

`docs:check` runs a chain of deterministic scripts (see
[`scripts/agent/docs/`](../scripts/agent/docs/)); any `error`-severity finding
fails the chain. Notably, every backtick-quoted repo path in `AGENTS.md`, the
root `README.md`, `.github/copilot-instructions.md`, the instruction files, and
the policy docs must resolve, and every ADR's cited paths must exist.
