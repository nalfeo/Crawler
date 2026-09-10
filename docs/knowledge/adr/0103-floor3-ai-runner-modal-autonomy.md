# ADR: Floor 3 AI-runner modal autonomy uses public presentation callbacks

## Status

Accepted

## Date

2026-09-03

## Estimated Complexity

🍎 x 2 — the change keeps the existing Floor 3 presentation surfaces and AI
runner lab, but rewires the lab automation and its deterministic coverage across
engine, game AI, lab, and e2e boundaries.

## Context

The AI-runner lab needs to exercise Floor 3 without a human, including the intro,
starter Companion, poach offer, versus, kept-Companion, and stair-descend modal
surfaces. Those surfaces are player-facing UI owned by the scene and scenario
presentation contract, but the lab previously had direct automation paths that
could close pickers or mutate scenario state without going through the same
confirmation callbacks as player input.

That split risks proving a lab-only path: automation can advance while the real
modal callback is broken, or it can resolve the wrong anonymous surface after
multiple Floor 3 blockers appear in sequence.

## Decision

- Treat the AI-runner lab as a UI driver for Floor 3 modal surfaces. It confirms
  recognized blocking pickers through `ModalPickerUI.handleKeyDown(Enter)`
  instead of directly closing the picker or mutating the selected scenario state.
- Give the lab enough surface identity telemetry to make this deterministic:
  `AiRunnerDebugSnapshot.modalKind` exposes the active modal kind and
  `floor3SurfaceTrace` records ordered `opened` / `confirmed` events with
  frame, elapsed game time, and world state.
- Keep headless/default simulation helpers unchanged by default, but let the
  visual lab opt out of direct Floor 3 kept-Companion and stair-descend shortcuts
  so those player-facing callbacks are exercised in the real scene path.
- Guard the contract with deterministic tests: source-string unit guards protect
  the cross-layer wiring assumptions, while the Floor 3 e2e acceptance scaffold
  observes ordered modal trace and resumed simulation in the real AI-runner lab.

## Consequences

### Positive

- The lab now fails when the player-facing Floor 3 callbacks fail, instead of
  passing through a private automation bypass.
- Modal ordering is observable through a deterministic debug trace that e2e tests
  can poll without depending on screenshots or wall-clock timing.
- Headless behavior remains compatible because direct progression remains the
  default outside the visual lab override.

### Negative

- The visual lab has a little more modal-specific orchestration code because it
  must distinguish public surfaces before pressing Enter.
- Source-string wiring guards need to track the public-confirmation helper rather
  than the older direct-close path.

### Risks

- A future Floor 3 modal without a stable kind can strand the visual lab if the
  direct shortcut is disabled. Mitigation: add the surface to the recognized
  modal-kind set and assert its ordered trace before disabling any fallback.
- Trace assertions can miss very short-lived events if sampled too sparsely.
  Mitigation: the lab records events at the source and exposes the accumulated
  trace through `window.__aiRunnerDebug()`.

## Alternatives Considered

- **Keep direct lab shortcuts.** Rejected because it bypasses the exact modal
  callbacks this PR needs to prove.
- **Make the e2e test click DOM/canvas coordinates.** Rejected because the modal
  is rendered in Phaser and the lab already has a deterministic public input path.
- **Change headless behavior to always drive UI-style modals.** Rejected because
  headless has no renderer and already owns scenario progression through direct
  callbacks; the risk is specific to the visual AI-runner lab.
