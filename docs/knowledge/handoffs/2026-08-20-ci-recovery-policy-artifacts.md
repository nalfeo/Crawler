# CI Recovery Policy Artifacts

## Summary

Updated CI Recovery, PR Shepherd, ADR, and review-harness guidance so missing
policy artifacts are treated as fixable work instead of automatic human
blockers. Recovery agents should now create missing ADRs, review ledgers, apple
records, handoffs, and ledger evidence from PR/review context whenever the
underlying decision is inferable.

## Systems touched

agent-policy, ci-recovery, review-harness, documentation

## Files touched

- `.github/agents/ci-review-validator.agent.md`
- `.github/agents/pr-shepherd.agent.md`
- `.github/skills/create-architectural-decision-record/SKILL.md`
- `.github/agents/ux-designer.agent.md`
- `docs/agent-os/policies/ci-policy.md`
- `docs/agent-os/policies/complexity-policy.md`
- `docs/agent-os/policies/memory-policy.md`
- `docs/agent-os/policies/review-harness-policy.md`
- `docs/knowledge/ux-feedback/README.md`

## Verification

- `npx tsx scripts/agent/docs/check-paths.ts`
- `npx tsx scripts/agent/docs/check-session-instructions.ts`
- `npx tsx scripts/agent/docs/check-personas.ts`
- `npx tsx scripts/agent/docs/check-adr-consistency.ts`

Full `npm run docs:check` cleared all blocking checks but was stopped after it
remained in the long advisory handoff-promotion phase for several minutes.

## Unresolved issues

- Existing advisory warning remains: `docs/knowledge/adr/2026-08-18-ten-slot-equipment-contract.md`
  is missing a `## Status` section. This is non-blocking and unrelated.

## Apples

Estimated: 🍎🍎 — docs/instruction-only policy update across existing agent
guidance.
Actual: 🍎🍎 — no code/runtime behavior changed; targeted validators passed.
