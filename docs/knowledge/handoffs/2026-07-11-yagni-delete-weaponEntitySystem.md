# Handoff: YAGNI delete — `weaponEntitySystem` + `spawnWeapon`

**Date:** 2026-07-11  
**Session slug:** yagni-delete-weaponEntitySystem  
**Branch:** closes #666  
**Apple estimate:** 1🍎

## Systems touched

weapons

## What was done

Resolved issue #666 by choosing **Option 2 (YAGNI delete)** for the latent, never-wired multi-weapon entity feature.

### Deleted artifacts

| Artifact                             | File                                           | Reason                                                              |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------- |
| `weaponEntitySystem`                 | `src/game/weaponSystem.ts`                     | Never referenced by any real pipeline (guard ADR 0039)              |
| `spawnWeapon`                        | `src/core/spawners/pickups.ts`                 | Only producer of `Weapon+Owner+Team` entities; called only in tests |
| `Weapon` ECS component               | `src/core/components.ts`                       | Exclusively used by the above two                                   |
| `weapon` typed-array store           | `src/core/components.ts`                       | Same; part of `createComponentStores`                               |
| `weaponEntitySystem` allowlist entry | `scripts/agent/health/orphaned-systems-lib.ts` | Entry was `trackedIssue: '#666'`; issue resolved by deletion        |

### Supporting cleanup

- `src/core/world.ts`: removed `Weapon` import and `wireStore(ecs, Weapon, stores.weapon)`
- `src/game/index.ts`: removed `weaponEntitySystem` re-export
- `docs/systems/03-weapons.md`: removed the `weaponEntitySystem` row and the `⚠️ not wired` warning block
- `docs/architecture.md`: removed `weaponEntitySystem` from the systems inventory table and weapons group summary row
- Tests: removed `weaponEntitySystem coverage paths` describe block from `tests/game/weapon-system-coverage.test.ts`, removed `spawnWeapon` describe block from `tests/ecs/spawners/pickups.test.ts`, removed `spawnWeapon` from the expected-helpers list in `tests/ecs/helpers.test.ts`

## Why delete rather than wire

- The player's weapon is already fully covered by the singleton `weaponSystem` (all 6 weapon types, accuracy, cooldown). No gameplay requirement calls for a multi-weapon-entity model at this time.
- YAGNI: the feature was complete but dormant — same failure class as `spawnerSystem` (ADR 0034 → 0036, PR #665), just resolved differently here.
- Reduces dead code, removes the orphaned-system guard allowlist entry, and unblocks the redundant/stale-allowlist guard check.

## Verification

- `npm run verify:fast` — all 3472 + 1155 tests pass ✅
- Parallel code review + CodeQL: no findings

## Acceptance criteria met (per #666)

- ✅ `weaponEntitySystem` is no longer in any source file
- ✅ Guard allowlist entry for `weaponEntitySystem` deleted
- ✅ Docs updated

## Lessons

None; straightforward YAGNI cleanup.
