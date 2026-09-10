# 2026-09-03 Goobers shadow dispatch recovery

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## What changed

- Replaced every startup-invalid `${{ runner.temp }}` workflow expression with
  a runtime `GOOBERS_INSTANCE="$RUNNER_TEMP/goobers-shadow-instance"`
  assignment in each consuming shell step.
- Isolated the shadow runner to a temporary source containing only the
  deterministic `crawler-lifecycle-shadow` workflow, avoiding model-harness
  preflight for the unrelated feature workflow.
- Created the instance `config/` directory required by Goobers v0.3.3
  materialization and enabled hidden-file artifact upload for
  `.goobers-shadow/`.
- Strengthened workflow regression coverage for the rejected expression class,
  all three runtime assignments, isolated source materialization, and hidden
  artifact upload.

## Runtime evidence

- Dispatch `33724792368` created and started the `Shadow parity report` job,
  proving the zero-job startup regression was fixed.
- Dispatch `33725442741` passed materialization and uploaded the diagnostic
  artifact, exposing the unrelated workflow's model-harness preflight.
- Dispatch `33726015081` completed every job step successfully. Its report was
  read-only with clean CI Recovery and Merge Train parity, and artifact
  `9882066124` uploaded all six shadow output files.

## Verification

- `npm run test:unit -- tests/unit/goobers-shadow.test.ts`
- `node .github/scripts/validate-goobers-contracts.mjs`
- `bash scripts/agent/verify-fast.sh`
- `gh workflow run goobers-shadow.yml --ref nalfeo-fix-goobers-shadow-dispatch`

## Apples

Estimated 3, actual 3 - exact: the startup expression fix required live
workflow iteration through materialization, deterministic execution, parity
comparison, and artifact publication.
