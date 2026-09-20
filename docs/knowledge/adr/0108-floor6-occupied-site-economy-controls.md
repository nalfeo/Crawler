# ADR 0108: Floor 6 occupied-site economy controls

## Status

Accepted

## Date

2026-09-20

## Estimated Complexity

🍎 x 2 — extends an existing renderer-neutral scenario seam across shared, game, and engine layers.

## Context

Floor 6 already authoritatively owned tower construction, sales, upgrade offers, currency, and phase gates. The presentation seam exposed only a vacant-site build request, leaving an installed tower's sell and upgrade actions unreachable through ordinary scene controls. The engine must not own Floor 6 economy state or bypass the scenario's atomic transaction functions.

## Decision

Extend `ScenarioPresentationContract.construction` with optional, renderer-neutral sell and upgrade requests plus a scenario-projected upgrade snapshot. Floor 6 implements those requests by delegating to its existing authoritative transactions. `MainGameScene` presents build choices for vacant sites and inspect/sell/upgrade choices for occupied sites, then only displays the returned result. The scene does not mutate currency, occupancy, offers, or phase state.

## Consequences

### Positive

- **POS-001**: Both mouse and touch site input reach all public Floor 6 economy actions through one existing construction picker.
- **POS-002**: Phase, affordability, unlock, duplicate, and occupancy checks remain deterministic and scenario-owned.
- **POS-003**: Future scenarios may opt into occupied-site actions without adding floor identity branches to the renderer.

### Negative

- **NEG-001**: The generic construction snapshot and contract gain optional fields that scenarios without upgrades must ignore.
- **NEG-002**: The occupied-site picker mixes a local sell action with global upgrade offers, so its wording must make their different scopes clear.

### Risks

- **RSK-001**: A future scenario can expose an incomplete optional request pair; the picker therefore disables unsupported actions rather than assuming the request exists.
- **RSK-002**: Presentation affordability can be stale for a frame, so every accepted input remains subject to the authoritative transaction response.

## Alternatives Considered

### Engine-owned Floor 6 economy UI

- **ALT-001**: **Description**: Add Floor 6 conditionals and direct economy writes to `MainGameScene`.
- **ALT-002**: **Rejection Reason**: It breaks scenario ownership, duplicates atomic validation, and makes renderer code responsible for game state.

### A separate upgrade menu unrelated to construction sites

- **ALT-003**: **Description**: Add a new global Floor 6 upgrade surface.
- **ALT-004**: **Rejection Reason**: It creates a second input path for a tightly related economy loop and does not make occupied towers inspectable.

### Unit-only request coverage

- **ALT-005**: **Description**: Verify callback delegation without a rendered picker.
- **ALT-006**: **Rejection Reason**: The original failure was a public scene-control gap; real-scene E2E coverage is required to protect the input and modal seam.
