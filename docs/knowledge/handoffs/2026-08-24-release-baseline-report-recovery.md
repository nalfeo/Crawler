# Handoff: Release baseline report recovery

## Systems touched

ci-policy

## Persona

DevOps Engineer

## Apples

2🍎 exact

## Summary

Repaired post-release baseline reporting so the PR comment targets the current
`dev/` Pages tier and fun-score deltas require matching release-leg IDs and
per-leg run counts in both the comment formatter and Pages renderer. Added
focused regression coverage for the Pages tier and optional-leg mismatch.

## Verification

- `npm run typecheck`: passed.
- Focused release-report tests: 14 passed.
- `npm run verify:fast`: passed.

## Key decisions

- Treat missing or mismatched `baseline.legs` as an incompatible fun cohort to
  avoid presenting a numeric delta from different optional release legs.
- Keep the release report under `dev/`, which deploys the current main commit;
  the Pages root remains independently built from the `production` tag.

## Next steps

- Complete final verification, review, security scanning, publish the repair,
  and respond to the three specified review threads with the resulting SHA.

## Retrospective

### Lessons learned

The Pages root is not a safe target for a newly merged main artifact because
deploy assembles it from the independently promoted production tag.

### Mistakes made

The original formatter assumed aggregate fun cohort data was enough; optional
release legs make aggregate run totals insufficient to establish comparability.

### Opportunities for future improvement

Share the release-leg cohort check between the TypeScript comment formatter and
the static HTML report to avoid maintaining duplicate comparison logic.
