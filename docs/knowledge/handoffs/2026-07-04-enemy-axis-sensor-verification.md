# Handoff: Enemy axis sensor — verification & design reinforcement

**Date**: 2026-07-04  
**Session**: remove-enemy-axis-sensor (verification checkpoint)  
**Persona**: Producer  
**Apples**: 🍎 (verification-only, no code changes)

## Systems touched

enemies

## Summary

Verified that the design decision from **2026-06-28 handoff** ("Enemies do NOT need an axis-orientation sensor") is correctly implemented across the sprite generation pipeline, tested, and enforced. No changes required.

## Design rule (confirmed in place)

Enemies (`brief.type === 'enemy'`) skip the `silhouette-orientation-axis` sensor entirely during sprite candidate scoring. This prevents false rejects when enemy silhouettes happen to be horizontal or other non-vertical orientations. Character sprites (`brief.type === 'character'`) **do** run the orientation check when `facing: 'front'` is set.

## Verification checklist

- [x] **Code implementation**: `scripts/sprites/score-candidate.ts` correctly conditions orientation-axis sensor on `brief.type === 'character'` only (lines 111-122)
- [x] **Documentation**: `scripts/sprites/brief-schema.ts` documents enemy sensors and explicitly notes orientation-axis is not used (line 149)
- [x] **Test suite**: `tests/unit/sprites/score-candidate.test.ts` includes 2 dedicated enemy tests for this constraint, plus 1 complementary character-side test (all passing)
  - "enemy briefs derive anchors from center of mass without orientation gating" (line 158) — an enemy brief scores **without** the `silhouette-orientation-axis` sensor
  - "enemy briefs ignore orientation-axis even when facing is front" (line 174) — the sensor stays absent even when `sensors.enemy.facing: 'front'` is set
  - "character briefs stay front-facing when an enemy sensor block omits facing" (line 188) — confirms **characters** still run the orientation check, proving the enemy-vs-character split
- [x] **Test count**: All 24 sprite scoring tests pass
- [x] **Fast verify**: `npm run verify:fast` ✅ passes

## Why this matters

Enemies are AI-controlled combatants, not player-facing characters. Their in-game orientation is determined by gameplay logic (facing player, flanking behavior), not by the sprite's pose at generation time. Applying a vertical-only constraint would needlessly reject valid enemy artwork that happens to lean, crouch, or spread horizontally.

Characters (the player) need the orientation check because the engine expects a canonical front-facing vertical pose that it can rotate smoothly for all movement angles.

## Files touched

- None (verification only)

## Unresolved issues

- None

## Recommended next steps

- Include this handoff in `docs/knowledge/handoffs/INDEX.md` as a reference for future art-generation discussions
- When onboarding sprite generalists, point to this decision as an example of how game logic shapes art constraints

## Agent-OS Telemetry

No telemetry artifact (verification checkpoint, no code changes).
