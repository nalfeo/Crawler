# ADR 0095: AI Runner Feature Flag Registry

## Status

Accepted

## Date

2026-08-30

## Estimated Complexity

🍎 x 3 — centralizes an AI runtime configuration contract shared by the headless runner and AI Runner lab.

## Context

The AI Runner lab exposes three boolean behavior gates: weapon personas, optional purchases, and settlement-return routing. Their metadata, defaults, persistence, UI controls, and runtime reads were declared independently. Adding another gate could therefore produce a partial feature that existed in one surface but was absent or defaulted differently in another. Settlement-return routing also has intentionally different defaults in the lab and direct headless runs, while optional purchases must retain deprecated-field migration semantics.

## Decision

- **DEC-001**: Define one typed AI-specific feature-flag registry in `src/game/ai/`.
- **DEC-002**: Each registry entry owns its stable key, human-facing label, and surface-aware default resolver.
- **DEC-003**: Resolve all runtime reads into one complete `AiFeatureFlags` record before consumers execute.
- **DEC-004**: Generate the AI Runner lab's dedicated Feature Flags folder from the registry rather than declaring controllers individually.
- **DEC-005**: Preserve old lab persistence and headless caller compatibility on reads while writing only the canonical feature-flag record.
- **DEC-006**: Keep unrelated world feature families, including Floor 2 equipment and attack-wave flags, outside this AI-runner registry.

## Consequences

### Positive

- **POS-001**: A newly registered AI runner flag automatically appears in the lab control section.
- **POS-002**: Type checking keeps registry keys, resolved state, persistence, and runtime consumers aligned.
- **POS-003**: Surface-aware defaults make existing behavior differences explicit and testable.
- **POS-004**: Legacy optional-purchase state continues to resolve through its established precedence rules.

### Negative

- **NEG-001**: Callers must resolve the complete flag record instead of reading optional booleans directly.
- **NEG-002**: The registry is deliberately AI-runner-specific, so other feature families retain their existing domain-owned configuration.

### Risks

- **RSK-001**: A future flag with more complex compatibility needs may require a dedicated resolver instead of the standard explicit-value/default path.
- **RSK-002**: Changing a surface default in the registry can affect many runs at once and therefore requires focused regression coverage.

## Alternatives Considered

### Keep Independent Boolean Fields

- **ALT-001**: **Description**: Add a new lil-gui folder but continue declaring and persisting every flag manually.
- **ALT-002**: **Rejection Reason**: This changes presentation without preventing metadata and consumer wiring from drifting again.

### Global Repository-Wide Feature Registry

- **ALT-003**: **Description**: Migrate every core, game, lab, and tooling feature gate into one global registry.
- **ALT-004**: **Rejection Reason**: Those flags have different owners and lifecycles; coupling them would greatly expand scope and erase useful domain boundaries.
