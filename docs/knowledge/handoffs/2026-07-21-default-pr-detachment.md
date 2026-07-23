# Default PR detachment

## Date

2026-07-21

## Persona

Producer, with DevOps workflow policy.

## Systems touched

ci-policy, agent-personas

## Apples

2 apples estimated, 2 apples actual (exact - a bounded instruction-policy change
plus its deterministic consistency check).

## Summary

- Made release-first cloud handoff the default for every ready-for-review PR.
- Unless the maintainer explicitly requests local ownership before publication,
  the implementation session now leaves complete PR and handoff context, then
  ends immediately instead of waiting for CI, reviews, or cloud confirmation.
- Documented why release must precede cloud assignment: an active session on the
  PR branch can keep the reconciler from assigning `copilot-swe-agent`.
- Kept explicit local Shepherd sessions available for pre-declared local
  ownership and later takeover work, but removed them from Producer's default
  publication path.
- Defined the existing event-driven CI Recovery router and its 10-minute
  scheduled sweep as the takeover path and backstop.

## Files touched

- `AGENTS.md`
- `.github/copilot-instructions.md`
- `.github/agents/producer.agent.md`
- `.github/skills/producer/SKILL.md`
- `.github/skills/pr-shepherd/SKILL.md`
- `docs/agent-os/personas/producer.md`
- `scripts/agent/docs/check-session-instructions.ts`

## Verification

- `npx tsx scripts/agent/docs/check-session-instructions.ts`
- `npx tsx scripts/agent/docs/check-personas.ts`
- `npm run verify:fast`
