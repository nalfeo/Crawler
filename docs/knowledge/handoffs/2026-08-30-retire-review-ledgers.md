# Retire review ledgers

## Summary

Replaced the committed review-ledger system with apple-scaled post-diff review:
1–2🍎 uses tests/CI only, 3🍎 requires one independent review, and 4–5🍎
requires two. Adversarial design review now applies only to architectural
changes, and GitHub reviews/threads are the sole review audit trail.

Deleted the validator, CLI, grader, branch check, guard, CI Recovery lifecycle,
and the full committed `docs/knowledge/review-ledgers/` artifact corpus. Existing
ADRs and handoffs remain unchanged as historical evidence.

## Systems touched

- Review policy, constitutional instructions, personas, specs, and skills.
- Package scripts, CI workflow wiring, PR prerequisites, and guard registration.
- CI Recovery blocker/review-request behavior.
- Floor 2 epic evidence validation and fixtures.
- Bottleneck telemetry remediation fixtures and active-source stale-string tests.

## Validation

- `npm run test:guards` — passed.
- Focused PR-prerequisite, CI Recovery, epic-status, bottleneck-scan, review
  instruction, and review-policy tests — passed.
- `npm run format:check` — passed.
- `npm run verify:fast` — passed after restoring model-selection guidance
  required by the review-instruction contract.
- `npm run docs:check` — blocked by a pre-existing missing path referenced from
  `.github/agents/ux-designer.agent.md`; that path is outside this session's
  explicit access boundary.

## Follow-up

Evaluate the first 30 merged PRs under the new policy against the preceding 30
using the deterministic success gates in
`docs/agent-os/policies/review-harness-policy.md`.
