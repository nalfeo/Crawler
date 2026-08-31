# CI Recovery Protected-Path Escalation

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated / 3🍎 actual — exact. The change added one bounded capability
classifier, terminal lifecycle routing, and focused state/reconcile regressions.

## Incident

CI Recovery exhausted two attempts on PR #3939 with one unresolved review
thread. The reviewer required changes under `.github/agents/**`; the recovery
agent reported that its session explicitly could not read or edit that protected
path, posted no resolution marker, and left the thread open. Run `33352807682`
then selected terminal row R34, filed incident #3956, and released ownership.

## Root cause

Marker parsing, GraphQL thread resolution, and mutation permissions worked as
designed. The reconciler treated the known recovery agent's non-marker reply
only as bounded prior-attempt context. It had no terminal classification for a
capability denial, so the same unfulfillable task consumed the retry budget.

The relevant denial also appeared after character 300 in the real reply, beyond
the existing blocker-hint truncation, so matching the displayed summary could
not have detected it.

## Fix

- Detect an explicit `.github/agents/**` capability denial from the full reply
  body only after the reply is tied to the current thread or a trusted task
  fingerprint and authored by a known recovery-agent identity.
- Preserve the result as normalized blocker metadata while keeping displayed
  prior-reply text bounded.
- Quarantine immediately with a distinct protected-path reason only when every
  remaining blocker is in that terminal class. Mixed blocker sets continue
  normal repair.
- Leave review threads unresolved and instruct an authorized maintainer/session
  to implement the protected-path change and post a valid marker before `KEEP`.
- Apply latest-wins semantics so a newer non-denial top-level reply clears an
  older denial for both exact blocker and stable thread IDs.

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs` — 79/79 pass
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 202/202 pass
- Targeted ESLint and Prettier checks — pass
- `bash scripts/agent/verify-fast.sh` — pass after implementation and after the
  code-review fix
- Separate-model plan review — approved with adopted refinements
- Code-review loop — one concern fixed; second round clean
- Independent grade — pass, five criteria scored 5/5
- Changed-file secret scans — clean

## Review finding addressed

Round 1 found that the stable-thread denial set could survive a newer top-level
non-denial reply. The map/set updates now share latest-wins add/delete behavior,
and the existing top-level prior-reply integration test models that sequence.

## Remaining action for PR #3939

This automation fix prevents another identical recovery dispatch after it lands.
PR #3939 still requires an authorized context to implement its protected-path
review request, post a valid resolution marker, and resolve the thread.
