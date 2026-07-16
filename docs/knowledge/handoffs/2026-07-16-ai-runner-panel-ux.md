# Handoff: AI Runner side-panel UX

## Systems touched

devtools, hud-ux, ci-policy

## Summary

- Rebuilt the AI Runner lab panel around a sticky expert command deck with one-click Control,
  Pause/Resume, Restart, and 1x/4x/16x speed presets at a 360x900 side-panel viewport.
- Separated "Restart current run" from staged seed/target application, preserving staged values
  across panel rerenders.
- Ported the sprite editor's blue-steel hierarchy, compact app bar, segmented actions, focus
  treatment, progressive disclosure, and restrained checker texture.
- Kept scan-critical state/target/persona telemetry visible while moving the verbose decision
  tree, debug controls, recorder, and shortcuts behind persistent disclosures.
- Preserved disclosure and keyboard focus state across the panel's existing innerHTML rerenders;
  Space no longer frame-steps while any interactive control is focused.
- Extended the visual-review agent with an explicit `--no-probe-wait` option so non-probe
  surfaces can be reviewed without weakening readiness for existing probe-backed surfaces.

## Observe before done

- Before: the live AI Runner panel wrapped playback buttons unevenly, mixed staged restart with
  primary commands below the dock, and scored 3.0/5 with three LLM blockers.
  `files/visual-review/ai-runner-panel-iteration-01-baseline-2026-07-16T16-47-36-828Z.png`
- After: the live `ai-runner` lab keeps all six required primary controls visible, non-overlapping,
  and center-clickable at 360x900. The browser test also verifies state transitions, current-run
  restart, sticky behavior, disclosure persistence, and focus restoration.
- Ten real Azure LLM vision rounds were completed. The final round retained a 3.0/5 score and
  three recurring spacing findings despite measured equal-column grids and zero deterministic
  blockers; the requested 10-round cap was reached without weakening the expert-density target.
  `files/visual-review/ai-runner-panel-iteration-10-final-2026-07-16T17-10-16-633Z.png`
  `files/visual-review/ai-runner-panel-iteration-10-final-2026-07-16T17-10-16-633Z.review.json`

## Validation

- `npm run typecheck`
- `npm run verify:fast`
- `npx vitest run --project e2e tests/e2e/ai-runner-side-panel.test.ts --reporter=dot`
- `npm run review:visual:deterministic`
- Ten `npm run review:visual:llm` iterations using
  `scripts/agent/review/setup/ai-runner-side-panel.js`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-16-ai-runner-panel-ux.review-ledger.json`

## Review harness

- Estimated/actual: 4🍎 / 4🍎.
- Adversarial plan review: `gpt-5.4`; three alternatives considered; major-fork outcome adopted.
- Code review: two rounds with `claude-sonnet-4.6`; two findings fixed, final round clean.
- Multi-model review: `claude-sonnet-5` + `gemini-3.1-pro-preview`, adjudicated by `gpt-5.4`;
  disclosure/focus/type-safety and probe-readiness findings resolved.
- Ledger: `docs/knowledge/review-ledgers/2026-07-16-ai-runner-panel-ux.review-ledger.json`.

## Unresolved issues

- The Azure vision judge continued to report spacing blockers after ten rounds even when the
  declared geometry showed equal grids and zero deterministic blockers. No further visual changes
  were made beyond the agreed iteration cap.
