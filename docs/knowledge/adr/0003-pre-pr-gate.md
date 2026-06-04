# ADR 0003 — Pre-PR Agent Gate

## Status
Accepted

## Context
Crawler relied on instructions alone for pre-PR discipline: verification, local review, and handoff updates were required in docs, but agents could still open PRs without leaving durable evidence in the repository.

## Decision
Adopt a deterministic pre-PR gate with two layers:

1. A repo-owned script, `scripts/agent/pre-pr-check.mjs`, that:
   - runs full verification
   - runs the lab gate
   - computes required personas from changed paths
   - validates the latest changed handoff includes review evidence
2. A Copilot CLI extension hook in `.github/extensions/pre-pr-gate/extension.mjs` that blocks PR creation until the pre-PR check passes.

The handoff becomes the durable record of:
- personas consulted
- review agents run
- feedback status

## Consequences
- PR creation is blocked until the repo contains explicit review/handoff evidence.
- The enforcement path is cross-platform because it uses Node scripts instead of Bash-only commands.
- Persona requirements remain policy-driven and may evolve as the codebase grows.
