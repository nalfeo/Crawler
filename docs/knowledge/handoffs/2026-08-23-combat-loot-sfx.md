# Session Handoff: Combat/Loot Procedural Sound Effects

## Date

2026-08-23

## Persona

Engine/UX Engineer (audio feedback layer)

## Systems touched

vfx, weapons, hud-ux

## Apples

4🍎 estimated, 4🍎 actual — new engine-layer subsystem plus review-feedback
round; see `docs/knowledge/review-ledgers/2026-08-23-combat-loot-sfx.review-ledger.json`.

## What Was Done

Added a procedural combat/loot SFX layer reusing ADR 0071's `AudioCueEngine`
primitive: a pure decision module (`src/shared/combat-audio-cues.ts`), a spec
table (`src/engine/audio/combat-cue-specs.ts`), engine glue with per-kind
cooldowns and a priority-ranked per-frame cue budget
(`src/engine/combat-audio.ts`), and `PhaserBridge` wiring that runs before the
`EffectsVfx`/`CombatVfx` drainers. Sources are the three existing render-event
queues (`combatEvents`, `abilityActivations`, `vfxEvents`) — zero new core/game
plumbing. Observed in the real artifact via
`tests/e2e/combat-audio-real-wiring.test.ts`, which boots the real
`MainGameScene` through `main-scene-probe-lab` — before: the
`combatAudioCueLog` stayed empty for a real ability activation and for real
`combatEvents`/`vfxEvents` entries; after: `combat:spell-cast`,
`combat:damage-taken`, and `combat:pickup` cues are dispatched to the real
injected `AudioCueEngine` on the next real render frame.

Review-feedback round: ability-sourced damage
(`CombatEvent.fromActiveAbility`) no longer plays weapon SFX — it maps to a new
`spellImpact` cue; the integration suite was rescoped to the claims it can
actually prove (mapping, never-drains, cross-frame throttling) with runtime
ordering left to the e2e; dangling "see ADR" references now name
`docs/knowledge/adr/2026-08-23-combat-loot-audio-cues.md`.

## Key Decisions Made

- Classify non-player hits from authoritative event metadata
  (`fromActiveAbility`), never from `targetType` alone, so spell damage and
  weapon strikes are audibly distinct.
- Keep the cue→`SynthCueSpec` table in `src/engine/audio/combat-cue-specs.ts`
  so it has a real production importer and a name that does not collide with
  `reward-opening-audio.ts`'s `synthSpecForCue` (the collision plus a
  test-only import path tripped `check:test-only-exports`).
- A test that drives its own frame order cannot prove production frame order;
  the booted-scene e2e is the ordering guard.

## What's Next / Blockers

No blockers. Future work: volume/mute settings surface for combat SFX (there
is no user-facing audio settings panel yet), and richer per-weapon-family
timbres once the weapon archetype key is plumbed through `CombatEvent`.

## Retrospective

### Lessons Learned

- `check:test-only-exports` flags any `src/` export whose only _imports_ are
  from `tests/**` — same-file internal use does not count. Moving the export
  to a module that a production file imports is the clean fix.
- knip flags a `const … as const` array that exists only to derive a union
  type; a plain union type avoids both the knip finding and the ESLint
  "assigned but only used as a type" error.

### Mistakes Made

- Initially mapped every non-player hit to weapon cues, which made spell
  damage play weapon SFX on top of its own cast cue. Early signal: the
  `fromActiveAbility` flag already existed on `CombatEvent` and was ignored.
- Claimed the integration test locked runtime call ordering when the test
  drove that ordering itself — a tautology that would have stayed green if the
  production call moved after a drainer.

### Opportunities for Future Improvement

- A deterministic guard that flags tests whose doc comment claims to lock a
  production call order while the test itself sequences the calls.
