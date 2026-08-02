# Copilot Instructions — Crawler

> **[`AGENTS.md`](../AGENTS.md) is the canonical agent contract for this repo.**
> Read it first — it carries the request-intake protocol, session Quick Start,
> the command table, layer rules, the numbered Rules, merge policy, and the
> known environment quirks. This file exists only to point at the canonical
> homes; it deliberately does **not** restate them.
>
> Every rule used to be written out three times (here, in `AGENTS.md`, and in
> `docs/agent-os/policies/`), which meant every policy change needed three
> synchronized edits — and they drifted. One home per rule, always.

## Project Context

Crawler is a crafting-focused vampire-survivors-like game set in a reality show
dungeon. It uses Phaser 4 for rendering and bitecs 0.4 for ECS game logic. This
project is entirely agent-driven.

## Where each rule lives

| Topic                                             | Canonical home                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request intake, Quick Start, Rules, merge policy  | [`AGENTS.md`](../AGENTS.md)                                                                                                                           |
| Commands, layer rules, environment quirks         | [`AGENTS.md`](../AGENTS.md)                                                                                                                           |
| Apple complexity scale + accounting               | [`docs/agent-os/policies/complexity-policy.md`](../docs/agent-os/policies/complexity-policy.md)                                                       |
| Apple-scaled review harness + review ledger       | [`docs/agent-os/policies/review-harness-policy.md`](../docs/agent-os/policies/review-harness-policy.md)                                               |
| Lab gating                                        | [`docs/agent-os/policies/lab-gate-policy.md`](../docs/agent-os/policies/lab-gate-policy.md)                                                           |
| CI policy and runtime-tweakable CI knobs          | [`docs/agent-os/policies/ci-policy.md`](../docs/agent-os/policies/ci-policy.md), [`ci-config-knobs.md`](../docs/agent-os/policies/ci-config-knobs.md) |
| Memory / handoffs / ADR tiers                     | [`docs/agent-os/policies/memory-policy.md`](../docs/agent-os/policies/memory-policy.md)                                                               |
| Guard-telemetry capture                           | [`docs/agent-os/policies/telemetry-policy.md`](../docs/agent-os/policies/telemetry-policy.md)                                                         |
| Persona routing                                   | [`docs/agent-os/personas/README.md`](../docs/agent-os/personas/README.md)                                                                             |
| PR / diff review contract                         | [`.github/instructions/review.instructions.md`](instructions/review.instructions.md)                                                                  |
| Tool-call-boundary guards (what is hard-enforced) | [`.github/extensions/copilot-guards/README.md`](extensions/copilot-guards/README.md)                                                                  |

Path-scoped rules for `src/core/`, `src/engine/`, `src/game/`, `src/game/ai/`,
`src/labs/`, `src/shared/`, and `tests/` live in
[`.github/instructions/`](instructions/) and are applied automatically by path.

## Pull Request Reviews

This one lives here rather than in `AGENTS.md`, because native GitHub Copilot
pull-request review reads this file.

For every pull request or diff review, follow the canonical exhaustive-review
contract in [`.github/instructions/review.instructions.md`](instructions/review.instructions.md).
Adopt its Reviewer persona, complete every review category before responding,
deduplicate by root cause, and return all validated findings in one pass. Before
commenting, read the complete prior review history; never reopen or repost a
finding that has a prior `✅ Addressed in <sha>` or `✅ Not applicable:` response
unless a later thread reply provides concrete evidence that the resolution failed.

## Editing these docs

When a rule changes, edit **only** its canonical home above. If you find the
same rule stated in two places, delete the copy and link to the home instead —
do not "fix both".
