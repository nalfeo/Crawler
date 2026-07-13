# ADR: Dedicated abilities loadout UI and shared presentation metadata

## Status

Accepted

## Date

2026-07-12

## Estimated Complexity

🍎 x 4 - crosses shared, game, and engine layers with real-scene input coordination,
generated sprite resolution, responsive UI, and deterministic browser coverage.

## Context

Ability configuration reused `ModalPickerUI`, a one-shot confirmation surface shared
by unrelated flows. That model closed after every action and could not express a
persistent loadout with immediate equip/remove behavior, scrolling, remembered
selection, or hotbar-specific presentation. Extending the generic picker would couple
ability semantics and input handling to every existing modal caller.

The engine also needs names, descriptions, short labels, cooldowns, categories, and
generated icon brief IDs to render the hotbar and loadout. The canonical ability
registry lived in `src/game/`, but the engine layer cannot import game code.

## Decision

- Add a dedicated engine-owned `AbilityLoadoutUI` for persistent ability management.
  `MainGameScene` owns orchestration, blocks other primary surfaces, freezes gameplay
  while the panel is open, and isolates keyboard/pointer interaction input from the
  world.
- Keep `ModalPickerUI` unchanged for one-shot confirmation flows such as the initial
  boss spell reward.
- Move canonical, immutable ability presentation data to
  `src/shared/ability-presentation.ts`. Both the game registry and engine UI consume
  that data, while mutable ability state remains in the game/world layers.
- Resolve optional generated icons through the engine's boot-loaded generated sprite
  registry. Missing art remains a supported state and renders a readable deterministic
  short-label fallback.
- Treat real-scene browser probes and deterministic geometry checks as the runtime
  contract for containment, overlap, input isolation, HiDPI hit testing, and selection
  restoration.

## Consequences

### Positive

- Ability management can remain open across multiple equip/remove actions without
  complicating unrelated modal flows.
- Presentation metadata has one source of truth without violating the engine-to-game
  dependency rule.
- Approved generated art appears automatically, while abilities without art stay
  legible.
- Real-scene tests lock UI exclusivity and prevent input from leaking into gameplay.

### Negative

- The engine owns another specialized UI surface and its lifecycle wiring.
- Presentation changes that affect gameplay and rendering require coordinated shared
  metadata review.
- Battle Focus and future abilities without approved sprites continue to use text
  fallback.

### Risks

- New direct scene input handlers can bypass panel isolation. This is mitigated by
  blocking-surface checks plus held-key and pointer regression coverage.
- Generated sprite metadata can exist before its texture is loaded. The resolver
  checks both registry shape and texture availability and falls back instead of
  rendering a broken image.

## Alternatives Considered

- **Restyle and extend `ModalPickerUI`.** Rejected because persistent toggles,
  scrolling, and loadout-specific input would burden every one-shot caller.
- **Add an opt-in abilities mode to `ModalPickerUI`.** Rejected because it preserves
  one class but still combines incompatible lifecycle and row semantics.
- **Keep presentation metadata in `src/game/` and duplicate it in the engine.**
  Rejected because engine imports would violate the layer rule and duplication would
  drift.
- **Require an icon for every ability before shipping.** Rejected because approved art
  is intentionally asynchronous; deterministic text fallback keeps the UX complete.
