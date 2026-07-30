# Velocity model-tier experiment + lab-boundary guidance

**Date:** 2026-07-25
**Apples:** 3🍎 estimated → 3🍎 actual
**Persona:** DevOps Engineer / velocity-engineer

## Systems touched

ci-policy, agent-personas

## What shipped

- Committed the bottleneck-scan paging fix already on branch (`fde3f3038`) and tightened it after review: the merged-PR cursor now overlaps the oldest timestamp by +1ms and relies on `seen` de-duplication so same-timestamp PRs are not silently dropped.
- Added regression coverage for `fetchMergedPrs` paging, de-duplication, cursor advancement, and no-progress bailout.
- Added the `model-tier` velocity experiment spec and raw report:
  - `docs/knowledge/metrics/velocity/experiments/model-tier.json`
  - `docs/knowledge/metrics/velocity/findings/2026-07-25-model-tier.report.json`
- Wrote the finding at `docs/knowledge/metrics/velocity/findings/2026-07-25-model-tier.md`.
- Updated `.github/agents/velocity-engineer.agent.md` with explicit **consult mode** for bottlenecks outside the replay-lab boundary.

## Key finding

The dominant 60-PR bottleneck is PR calendar idle/automation handoff time, not merge execution and not agent patch-to-green effort. The velocity lab cannot measure that directly; running a lab A/B for PR idle latency would be a category error.

The largest lab-addressable effect was model tier on bounded patch-to-green tasks. `claude-haiku-4.5` matched `claude-sonnet-4.6` at 100% pass rate on `smoke-blood-pool`, with ~2.7× lower nanoAIU and ~20% faster wall clock, but +3.5 median turns and higher turn variance.

## Validation

- `npm run velocity:experiment -- --spec docs/knowledge/metrics/velocity/experiments/model-tier.json --dry-run --out files/velocity-reports/model-tier-dry.json`
- Live report captured at `files/velocity-reports/model-tier.json` and copied into findings.
- `npx vitest run --project unit tests/unit/velocity/bottleneck-scan.test.ts`
- `npm run verify:fast`

## Review

Review ledger: `docs/knowledge/review-ledgers/2026-07-25-velocity-model-tier.review-ledger.json`

- Plan review: `gpt-5.4-mini`, convergent, no concerns.
- Code review round 1: 2 valid concerns (missing paging regression test; same-`mergedAt` cursor data loss), both fixed.
- Code review round 2: clean.

## Next

1. Do not spend replay-lab trials on PR idle latency. Route it to DevOps/automation consult mode.
2. Add durable PR/run-history field telemetry: first run created, `action_required` spans, retrigger source, handoff owner.
3. Field-trial haiku routing only for tiny, test-backed tasks; keep higher-tier models for design, review, and ambiguous work.
