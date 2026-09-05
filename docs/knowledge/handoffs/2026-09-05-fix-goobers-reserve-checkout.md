# Fix Goobers reserve sparse checkout

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended** — live issue-triggered runs consistently failed before
  reservation because a directly invoked checked-in selector was absent.
- Apple estimate: **2**

## Summary

Fixed the live `Reserve Goobers recovery target` failure seen in Actions runs
`33946058885` and `33946003724`. The reserve job's sparse checkout contained
only `scripts/agent`, but `Resolve Goobers recovery target` invokes
`.github/scripts/goobers/intake-selection.mjs`. The checkout now includes the
smallest safe cone containing that selector: `.github/scripts/goobers`.

Audited every sparse checkout in `goobers-run.yml`. The only other sparse job,
`release-unstarted-reservation`, directly references only
`scripts/agent/goobers-reservation-lease.sh`, which its existing
`scripts/agent` checkout already includes.

Added a structural workflow regression that enumerates every sparse job,
extracts checked-in `.github/**` and `scripts/**` file references from all
following shell steps, verifies those files exist, and verifies each is covered
by the declared sparse checkout. Its failure message names the job, missing
path, current checkout paths, and remediation. The test also explicitly pins
the reserve job's `intake-selection.mjs` dependency.

## Validation

- Parsed `.github/workflows/goobers-run.yml` and ran `bash -n` over every
  extracted shell step in both sparse jobs.
- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts
tests/unit/goobers-run-slot-cleanup.test.ts
tests/unit/goobers-contracts.test.ts --reporter=dot` — 144 passed, 2
  platform-gated skips.
- `npm run verify:fast`

## Apples

Actual: **2** — exact estimate; the repair stayed within the workflow and its
focused deterministic regression coverage.
