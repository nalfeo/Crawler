# Goobers automatic trigger and recovery

## Systems touched

agent-tooling, ci

## Apples

Estimated: 3🍎 — actual: 3🍎. Exact: the workflow, native retry controls,
regression test, and operator documentation matched the planned automation
slice.

## Summary

- `Goobers Run` now starts when an open issue receives `goobers:approved`,
  while retaining manual dispatch.
- An hourly `:37` sweep rediscovers approved issues after missed webhooks or
  terminal failures. Static concurrency keeps all entry points serialized.
- Non-manual events receive the same pinned Goobers, Copilot CLI, and workflow
  defaults as manual dispatches, and automated runs check out the trusted
  default branch without persisting checkout credentials.
- Native Goobers controls allow two plan, implementation, and review attempts
  and at most two gate repasses. Claiming and provider-mutating stages are not
  blindly retried, and the outer `goobers run` command is never shell-looped.
- A deterministic YAML contract test protects triggers, filters, defaults,
  concurrency, and retry boundaries.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts` — 3
  tests passed.
- Pinned Goobers v0.2.2 archive SHA256 verification plus
  `goobers validate --source-tree .goobers` — passed.
- `npm run verify:fast` — passed twice, including after review refinements.
- Independent grade — pass, five criteria scored 5/5.

## Follow-up

- The first post-merge labeled issue or hourly sweep will provide live
  GitHub-hosted observation of the new trigger path.
