# Handoff: PR #3420 main reconciliation

## Systems touched

enemies, companion-progression, ci-policy

## Persona

Producer

## Apples

3🍎 estimated, 2🍎 actual — the overlapping implementation had already landed
on main, reducing recovery to conflict reconciliation and documentation cleanup.

## Summary

Merged current `main` into PR #3420 with a true two-parent merge commit. Main's
newer Floor 3 implementation superseded every conflicting source and test hunk,
including the R6 per-Studio `unlockLevel` soft gate and its regression coverage.
The branch's obsolete duplicate spec note, handoff, apple record, and incomplete
review ledger were removed; the resulting source and canonical spec match main.

The R6 review thread was marked addressed by merge commit `266b0ae4`. The
Companion-vs-Companion damage thread remains unresolved: main retains the
party-wipe predicate but does not add a team-aware damage path, and the existing
independent-validator reply correctly escalates that gameplay scope decision.

## Verification

- Targeted Floor 3/Companion tests: 50 passed.
- `bash scripts/agent/verify-fast.sh`: passed.
- Prior PR CI run `32674342868`: 19 jobs, zero failed jobs.
- Secret scan: clean.
- Final code review: no finding in the resulting PR delta.
- CodeQL: zero alerts reported; JavaScript analysis skipped because the database
  exceeded the tool's size limit.

## Recommended next steps

- Keep the Companion-vs-Companion combat thread unresolved until a human or
  Producer decides whether to implement combat now or formally defer it.
- Let CI Recovery and the merge train process the synchronized branch.
