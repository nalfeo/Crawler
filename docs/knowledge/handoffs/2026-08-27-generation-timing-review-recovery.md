# Generation timing review recovery

**Date:** 2026-08-27
**Persona:** Graphics Designer
**Apples:** 2🍎 estimated / 2🍎 actual

## Systems touched

sprite-pipeline

## Outcome

Recovered the timing-attribution PR from five validated review findings:

- processing, slicing, and candidate-persistence spans now finish when their
  measured work throws;
- checkpoint totals use the declared pipeline stage order; and
- checkpoint timing construction no longer follows an unreachable terminal
  statement.

## Verification

- `npm run typecheck`
- Focused sprites timing/checkpoint/full-run tests (28 passing)
- `npm run test:sprites` (2,375 passing)
