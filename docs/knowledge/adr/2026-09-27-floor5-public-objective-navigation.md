# ADR: Floor 5 public objective navigation

## Status

Accepted

## Date

2026-09-27

## Estimated Complexity

🍎 x 3 — aligns core quest presentation, production AI control, and the rendered lab.

## Context

Floor 5's quest sequence ends when the Ratings Ram is built, while the siege continues through the breach, courtyard, Regent, and a separate throne-capture interaction. The production AI therefore had no normal navigation target for the finale. Headless also bypassed the capture marker by repeatedly calling the capture authority.

## Decision

Use the existing public quest-waypoint and scenario stair-marker presentation contracts as the sole Floor 5 AI navigation surfaces. The AI follows the visible throne marker after the quest chain ends. Both headless and MainGameScene confirm capture only when the marker is visible, unlocked, and within its authored interaction radius.

## Consequences

### Positive

- The normal headless and rendered paths use the same observable objective and interaction gates.
- Capture attempts are legitimate, bounded player-control actions rather than runner shortcuts.
- The AI can complete the authored finale without reading private siege state.

### Negative

- Floor-specific terminal markers must remain available through the presentation contract.

### Risks

- A future marker contract regression can strand the AI after combat; the production-controller route regression covers this path.

## Alternatives Considered

- Read `floor5Siege` directly in the AI: rejected because it couples production control to private scenario internals.
- Auto-capture every headless frame: rejected because it produces denied interactions and differs from real play.
- Add a Floor 5-only teleport or finale hook: rejected because it would not verify ordinary movement.
