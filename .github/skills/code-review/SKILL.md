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

Use `.github/instructions/review.instructions.md` as the canonical review
protocol. Do not substitute, abridge, or reinterpret required categories,
process, or reporting structure.

## Required repo context

- Follow `.github/instructions/review.instructions.md` as canonical review policy.
- Apply Crawler-specific guardrails from `AGENTS.md` (determinism, wiring, lab-vs-runtime evidence, policy checks).
- Treat deterministic checks as authoritative; avoid style-only comments.
