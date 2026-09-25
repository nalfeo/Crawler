# ADR 0110: Versioned experience evaluation evidence

## Status

Accepted

## Date

2026-09-25

## Estimated Complexity

🍎 x 3 — changes the telemetry/report contract and its diagnostic consumers.

## Context

The fun evaluator assigns enjoyment-like names and confidence to uncalibrated
heuristics. Starting-weapon mix raises its choice score without changing play;
duplicated records raise confidence; missing human telemetry looks like observed
zeroes. Aggregate totals cannot establish perceived growth or build diversity.

## Decision

- **DEC-001**: Version new reports as v2, label scores uncalibrated heuristics,
  and report direct survey responses separately. Confidence in human enjoyment
  is unmeasured; tension has no assumed positive or negative direction.
- **DEC-002**: Producers identify source, seed, initial floor, and measurement
  availability. Missing required evidence yields null dimensions and a failed
  heuristic gate. Legacy records are readable but do not acquire invented data.
- **DEC-003**: Keep scenario evidence and per-run diagnostics. Require identical
  scenario multisets and report versions for descriptive comparisons. These
  comparisons are not significance tests or claims about human preference.
- **DEC-004**: Report starting-weapon coverage separately from the score. Choice
  depth and build distinctness remain unmeasured. Output and acquired progression
  heuristics saturate instead of penalizing exceeding their reference values.
- **DEC-005**: Preserve the independent Floor-1 win-rate contract and the
  diagnostic-only release policy. Use existing TypeScript/Vitest infrastructure;
  no statistical library is needed because no calibrated predictor is claimed.

## Consequences

### Positive

- **POS-001**: Missing data and repeat records cannot manufacture enjoyment
  confidence or a passing measured result.
- **POS-002**: Source data remains auditable and historical reports remain readable.

### Negative

- **NEG-001**: Legacy or partially instrumented runs may have no aggregate score.
- **NEG-002**: Actual enjoyment and meaningful choice still require human
  calibration and richer decision evidence.

### Risks

- **RSK-001**: Consumers must handle nulls and refuse cross-version comparisons.
- **RSK-002**: Reference thresholds remain hypotheses, even after removing
  known measurement errors; heuristic movement does not prove improved fun.

## Alternatives Considered

- **ALT-001**: Rename the existing fields only. Rejected because weapon labels
  would still improve a score and missing data would still appear measured.
- **ALT-002**: Replace the entire pipeline with a human-trained predictor.
  Deferred because labeled sessions are unavailable and the deterministic
  regression infrastructure remains useful.
