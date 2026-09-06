# Session Handoff: Fix pistol skill taxonomy and player-facing names

## Date

2026-09-06

## Persona

Producer

## Systems touched

weapons,hud-ux

## Apples

2🍎 exact

## What Was Done

Fixed the pistol weapon-skill milestone chain so the canonical active abilities are `pistol-shot-base`, `pistol-rapid-fire`, `pistol-shot-evolved`, and `pistol-barrage` instead of stale passive aliases like `pistol-volley` and `pistol-volley-evolved`. This keeps the displayed labels on the real ability pipeline human-readable and prevents internal hyphenated IDs from leaking into the UI. Observed in the game-side ability pipeline tests: before the pistol milestones resolved to passive stubs and stale `pistol-volley` names, after the fix the active weapon-type definitions and presentation names resolve to `Rapid Fire`/`Barrage` without exposing internal IDs.

## Key Decisions Made

- Keep pistol skill unlocks on the active ability path whenever the presentation metadata and trigger behavior are active.
- Preserve compatibility aliases for legacy `pistol-volley` IDs so older persisted state or stale references still resolve to the canonical active abilities.
- Lock the contract with deterministic registry tests so future drift is caught before it reaches the HUD/ability bar.

## What's Next / Blockers

None.

## Retrospective

### Lessons Learned

The pistol bug was a data drift issue: the shared presentation layer already treated the pistol abilities as active, but the registry and milestone IDs were still using stale passive names and aliases. Matching the canonical active IDs to the presentation layer eliminated the drift without broad changes to unrelated weapon types.

### Mistakes Made

None significant.

### Opportunities for Future Improvement

Audit the other weapon-type milestone IDs against the shared presentation layer so the same drift issue does not reappear for non-pistol weapon families.
