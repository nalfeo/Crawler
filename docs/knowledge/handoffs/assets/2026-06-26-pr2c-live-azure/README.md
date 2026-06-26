# PR2c — live-Azure E2E evidence (DoD closed)

Real artifacts from running the PR2c 7-stage flow against **live Azure OpenAI**
(`gpt-image-1` + `gpt-4o`) with the run store on `azure-blob` and durable
workflow-state round-tripping through Azure blob. Captured one-time, locally,
cost-consciously (1 generation + 2 judge calls). See the 1:1 DoD→evidence map in
[`../../2026-06-26-pr2c-sensor-viz-force-judge.md`](../../2026-06-26-pr2c-sensor-viz-force-judge.md)
(§ "Validated against live Azure").

Run under test: `skull-mace / 2026-06-26T22-20-57-74f0559a` (16 variants; 5 fail
the `anchor-derivable` sensor: variants 0, 1, 4, 8, 12).

| File                                          | DoD     | What it shows                                                                                                                |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dod1-generate.json`                          | 1       | `generate` → 200, real `gpt-image-1` sheet stored to Azure blob.                                                             |
| `dod2-postprocess-sensor-summary.json`        | 2       | `postprocess` on the STORED sheet (no regen) → 16 variants, 5 sensor failures.                                               |
| `dod3-judge-passing.json`                     | 3       | `judge {variantIndexes:[2]}` on a sensor-passing variant → real `gpt-4o` scorecard.                                          |
| `dod5-judge-failing-gated.json`               | 5       | `judge {variantIndexes:[0]}` (no force) → `judgeSkipReason:'sensor-failed'`, no verdict (gate held).                         |
| `dod5-judge-failing-forced.json`              | 5       | `judge {force:true,variantIndexes:[0]}` → real `gpt-4o` scorecard despite `passed=false` (gate overridden).                  |
| `dod4-5-sensor-detail-and-force-controls.png` | 4, 5    | Devtools UI: per-variant sensor-failure detail + run-level **Force judge** and per-variant **Force judge variant** controls. |
| `dod6-resume-after-refresh.png`               | 6       | After `localStorage.clear()` + reload, the run re-rendered purely from durable Azure workflow-state.                         |
| `dod4-5-6-playwright-ui-result.json`          | 4, 5, 6 | Headless-Chromium assertions backing the two screenshots.                                                                    |

No secrets: JSON contains only public blob URLs + scorecard text. Azure creds
(`.env.local`) are gitignored and were never committed.
