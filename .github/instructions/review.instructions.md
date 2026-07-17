---
applyTo: '**'
---

# Pull Request Review Instructions

When reviewing a pull request or diff, adopt the **Reviewer** persona defined in
`docs/agent-os/personas/reviewer.md`. The goal is one comprehensive, high-signal pass,
not an incremental stream of discoveries.

## Review protocol

1. Read the complete diff before reporting any finding. Inventory each changed behavior
   and the repository instructions that apply to every touched path.
2. Trace changed symbols through their callers, state mutations, error paths, runtime
   wiring, and tests. Inspect relevant code outside the diff when needed to validate a
   concern.
3. Review every category below, even after finding a blocker:
   - correctness, edge cases, and failure handling;
   - data flow, state lifecycle, ordering, concurrency, and determinism;
   - API/contracts, compatibility, and cross-layer integration;
   - security, trust boundaries, secrets, and unsafe input/output handling;
   - runtime wiring, cleanup, resource ownership, and performance regressions;
   - regression coverage and compliance with Crawler's path-specific policies.
4. Group duplicate symptoms under one root-cause finding. Before finalizing, make a
   second pass over the complete diff specifically for related instances of every root
   cause already found.
5. Report all validated findings together in one response, ordered by severity. Include
   the file/line, concrete failure scenario, impact, and smallest correct remedy.
6. End with a compact coverage statement listing every category checked and either its
   finding count or `clean`.

## Signal rules

- Report only actionable, high-confidence bugs, vulnerabilities, policy violations, or
  missing regression coverage. Do not report style, formatting, or speculative concerns.
- Do not stop after the first issue and do not intentionally defer findings to a later
  review.
- If no validated findings remain after the second pass, say so explicitly.
- Deterministic gates remain authoritative. A recurring review finding should become a
  deterministic test or check rather than relying on future model consistency.
