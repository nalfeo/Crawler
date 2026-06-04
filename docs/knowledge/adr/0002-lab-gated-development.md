# ADR 0002: Lab-Gated Development

## Status
Accepted

## Date
2024-12-01

## Context
This project is entirely agent-driven (vibe-coded). Agents can introduce bugs or regressions that aren't caught until integration. We need a development pattern that forces isolated testing before integration.

## Decision
Adopt lab-gated development:
1. Every ECS system in `src/core/systems/` must have a corresponding lab in `src/labs/<system>-lab/`
2. Labs are Phaser sandboxes with lil-gui controls for parameter tuning
3. CI script `scripts/agent/lab-gate-check.sh` enforces this — PRs fail if a system has no lab
4. Labs serve as both dev tools and visual documentation

## Consequences
### Positive
- Systems are tested in isolation before integration
- lil-gui controls make parameter tuning visual and interactive
- Labs serve as documentation for how systems work
- New developers (agents) can understand a system by running its lab

### Negative
- Every system requires additional lab code (overhead)
- Lab maintenance burden grows with system count
- Some systems are hard to visualize in isolation

## Alternatives Considered
- **Unit tests only**: Sufficient for logic, insufficient for visual/feel verification
- **Integration-first**: Faster to start but harder to debug
- **Storybook**: Web-focused, not ideal for game systems
