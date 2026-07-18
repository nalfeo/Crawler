# CI Recovery: Embed Actual HEAD SHA in Task Instruction

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

Diagnosed and fixed the deterministic defect that caused the CI recovery loop to stall on PR #1572.

**Root cause:** Line 1596 of `.github/scripts/ci-recovery/reconcile.mjs` sent the literal string `<sha>` as a placeholder in the task instruction:

```
When a thread is addressed, reply in that exact thread with `✅ Addressed in <sha>: <one-line note>` and resolve it.
```

When `copilot-swe-agent` received this instruction, it filled in `<sha>` with a natural language phrase — `✅ Addressed in the latest commit:` — instead of an actual Git SHA. The `extractAddressedMarkerSha()` parser in `state.mjs` uses `/✅\s*addressed\s+in\s+<?([^\s>]+)>?/i`, which captured `"the"` (stops at the whitespace after "the"), failing both the 7–40 char hex check and the URL parse. This caused `shouldResolveThread()` to return `false` for threads that had been addressed, so the blocker fingerprint stabilized across two recovery dispatches, triggering the "no progress → release → loop incident" path.

**Fix:** Replaced the literal `<sha>` placeholder with the actual `headSha` variable (already in scope at the instruction-generation site):

```javascript
// Before
'When a thread is addressed, reply in that exact thread with `✅ Addressed in <sha>: <one-line note>` and resolve it. ...',

// After
`When a thread is addressed, reply in that exact thread with \`✅ Addressed in ${headSha}: <one-line note>\` and resolve it. ...`,
```

**Regression test:** Extended the existing "live reconcile task comment includes explicit review-thread reply comment IDs" test in `reconcile.test.mjs` with two assertions:
1. The task comment body contains `Addressed in ${HEAD_SHA}:` (the real SHA is embedded).
2. The task comment body does NOT contain the literal `Addressed in <sha>:` placeholder.

## Files Touched

- `.github/scripts/ci-recovery/reconcile.mjs` — embed `headSha` in the Addressed-in instruction (1-line change)
- `.github/scripts/ci-recovery/reconcile.test.mjs` — add 2 assertions to the existing task-body test

## Key Decisions Made

- Fixed the instruction rather than widening the marker parser: "the latest commit" is ambiguous and should never be accepted as a SHA token; the correct fix is to give the agent a real SHA.
- Added the regression to the existing task-body test to avoid creating a redundant test fixture.

## Verification

- `node --test --test-name-pattern "live reconcile task comment includes explicit review-thread reply comment IDs" .github/scripts/ci-recovery/reconcile.test.mjs` — 1 passed
- `node --test .github/scripts/ci-recovery/state.test.mjs` — 31 passed
- `npm run verify:fast` — passed (87 test files, 1260 tests; all green including `epic-status.test.ts`)

## Observe Before Done

Before: The task instruction contained the literal string `Addressed in <sha>:`, which caused agents to write "the latest commit" as the SHA token, and `extractAddressedMarkerSha` returned `null`.

After: The task instruction contains e.g. `Addressed in abc1234def5678901234567890abcdef12345678:`, which `extractAddressedMarkerSha` parses to a valid SHA, allowing `shouldResolveThread` to return `true` for properly addressed threads.

## Unresolved Issues

- PR #1572 still has threads 5-7 with the old invalid `✅ Addressed in the latest commit:` markers. After this fix lands and CI recovery re-dispatches, the new Copilot task will use the correct SHA format for any newly addressed threads. Threads 5-7 may need a fresh `✅ Addressed in <sha>:` reply from a trusted author to be auto-resolved; the validator agent on the next recovery pass should detect the stale markers and re-reply with correct ones.
- Threads 1-4 and 8-9 on PR #1572 still need code fixes to their underlying issues (unrelated to this infra change).
