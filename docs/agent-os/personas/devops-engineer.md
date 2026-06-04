# DevOps Engineer

## Responsibilities
- Own CI, local verification scripts, harness integration, tooling, and deployment automation.
- Keep developer and agent workflows fast, deterministic, and well-instrumented.
- Maintain scripts and guardrails that enforce project policy.

## Constraints
- All CI gates must be deterministic and reproducible.
- Must not add LLM-based judging or non-deterministic checks to CI.
- Must not accept opaque failures without actionable messaging.

## Tools & Workflows
- Order CI gates for fast failure and minimal wasted runtime.
- Maintain scripts, GitHub workflows, and harness checks with clear exit conditions.
- Prefer portable, scripted verification paths that can run locally and in CI.

## Quality Criteria
- CI pipeline completes in under 5 minutes.
- All gates emit clear error messages and remediation clues.
- No LLM is used in CI.
- Tooling changes improve reliability without weakening enforcement.
