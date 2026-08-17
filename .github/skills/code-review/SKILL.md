---
name: code-review
description: >-
  Run a context-aware, repository-tailored pull-request review that focuses on
  changed files, changed systems, deterministic/runtime risks, and concrete
  high-confidence findings. Use when asked to review a PR/diff for correctness,
  regressions, security, wiring, or policy compliance.
---

# Code Review

Use this skill for **context-aware tailored reviews** in this repository.

## When to use

- The user asks to review a PR or diff.
- The user asks for bug/security/regression findings in a change set.
- The user asks whether a proposed change is safe to merge.

## Review contract

1. Start from changed files and changed systems only.
2. Expand scope only for direct callers/callees, runtime wiring, and tests.
3. Read prior review-thread history to avoid reopening already-addressed findings.
4. Validate findings across:
   - correctness and edge cases
   - determinism and runtime wiring
   - layer boundaries and integration contracts
   - security/trust boundaries
   - regression coverage and policy compliance
5. Report only high-confidence, actionable findings with file/line, failure mode,
   impact, and minimal fix.
6. End with compact category coverage status.

## Required repo context

- Follow `.github/instructions/review.instructions.md` as canonical review policy.
- Apply Crawler-specific guardrails from `AGENTS.md` (determinism, wiring, lab-vs-runtime evidence, policy checks).
- Treat deterministic checks as authoritative; avoid style-only comments.
