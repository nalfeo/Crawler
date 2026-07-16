# ADR: Primary-stat system overhaul — EffectiveStats unification, typed damage scaling, encumbrance, and full mana removal

## Status

Accepted

## Date

2026-07-16

## Estimated Complexity

🍎🍎🍎🍎🍎 — redefines all seven primary stats' per-point rates, removes a
primary stat (`weight`) and an entire resource system (mana) end-to-end,
replaces the positional `applyDamage` signature with a fail-closed typed
options object across every damage-bearing/delayed entity path, reworks every
spell's numeric outputs to explicit `{base, scalesWithIntelligence}` fields,
adds a fully-wired-but-currently-inert encumbrance system, and rewrites the
default AI stat allocator. Touches `shared/`, `core/`, `game/`, `engine/`,
`labs/`, and the full test suite.

## Context

The stat system had accumulated several structural problems the maintainer
wanted resolved in one pass rather than patched incrementally:

- **Two parallel stat pipelines.** A computational game-layer `statsSystem`
  wrote a legacy `Stats` component/store (`stores.stats`) that some combat
  paths still read, while a separate `EffectiveStats` pipeline (base + core
  allocation + equipment + secondary derivation) was the one Luck/Dexterity/
  crit/dodge actually flowed through (ADR 0018). Two stat surfaces for one
  character sheet invited drift and dead reads.
- **`weight` was a placeholder primary stat with no gameplay effect**
  (ADR `2026-07-10-core-stat-scaling-weight-placeholder.md`), reserved for
  "future momentum/knockback-facing progression work" that never landed. The
  approved contract instead keeps the ECS `Weight` component (body mass, used
  by knockback/drop) but removes `weight` as an allocatable primary stat
  entirely, replacing its future role with equipment weight + encumbrance.
- **Strength's payoff was a generic `damagePercent` secondary**
  (`2026-07-10-shared-stat-allocation-and-runtime-derivations.md`), which
  conflates physical and magical offense — a mage's Strength investment (via
  gear) would inflate spell damage the same as a warrior's, and there was no
  symmetric Intelligence payoff for magic weapons/spells.
- **Damage scaling was gated on the TARGET's component shape, not the
  SOURCE's origin** (`apply-damage.ts`): `!isPlayerTarget && hasComponent(
target, Enemy)` triggered player-stat scaling and a crit roll for ANY hit
  on an enemy — corpse-step damage, trap splash, or a future enemy-friendly-
  fire hit would all silently inherit the player's damage bonus and crit
  chance. This is a latent correctness bug the new fail-closed typed options
  (origin/affinity/scaleWithPrimary/canCrit) close off.
- **Mana was a fully-built, mostly-unused system.** World MP state
  (`playerMp`/`playerMaxMp`), a `manaSystem`, an MP HUD bar, `mpCost` on every
  ability, a mana-flask consumable, and a mana lab all existed
  (ADR 0019), but spells were never meaningfully MP-gated in practice (no
  spell cost tuning existed beyond flat placeholder values) and the maintainer
  wants ability access gated purely by unlock progression + cooldown, not a
  second resource pool.
- **The default AI stat allocator was physical-only** (`strength → armor`
  sequence), so a magic-weapon AI playthrough would still pump Strength
  instead of Intelligence, and the sequence didn't include Dexterity/Wisdom at
  all.

The maintainer supplied an exact, fully-specified contract (rates, caps,
formulas, removal list) and this ADR records the architecture chosen to
implement it, following a completed adversarial plan review (6 alternatives
considered, 19 concerns resolved — see
`docs/knowledge/review-ledgers/2026-07-16-overhaul-primary-stats.review-ledger.json`).

## Decision

1. **`EffectiveStats` becomes the sole runtime stat snapshot.** The legacy
   `Stats` component/store and the computational game-layer `statsSystem` are
   deleted outright. `core/systems/statSystem.ts` is now the only per-frame
   stat recompute: it prunes expired `world.statModifiers`, calls the one
   pure derivation (`computeEffectiveStatsFromLoadout` — base, core-stat
   points, unique equipped-item bonuses, active modifiers), and syncs
   `Health.max/current` by delta. Allocation/modifier APIs (`spendPoints`,
   `addStatModifier`, `removeStatModifiers`) remain in
   `game/systems/statsSystem.ts` as a non-system module — the file keeps its
   name but no longer exports a `(world) => void` system.
2. **Player Health seeds to derived max HP at spawn.**
   `equipmentSystem.initializeBaseStats` now calls `recomputeEffectiveStats`
   then sets `Health.max/current` to the freshly-derived `effectiveStats.
maxHp`, so a base-CON(1) character starts at exactly 170 HP
   (`BASE_MAX_HP_FLOOR = 160` chosen so `160 + 10×1 === 170`) and `statSystem`'s
   delta-sync sees `prevMaxHp === newMaxHp` on the first tick — no creep.
3. **Legacy modifier semantics are preserved through an explicit fold table**
   (`foldLegacyStatModifier`, `shared/stats.ts`): additive `damage` → flat
   `damageBonus`; multiplicative `damage` → generic `damagePercent`; every
   other legacy stat key (`maxHp`/`armor`/`attackSpeed`/`moveSpeed`/
   `accuracy`/`pickupRange`/`projectileSpeed`/`projectileCount`) folds
   additively into its same-named `EffectiveStats` field regardless of `op`
   (no current registry data exercises `multiply` on these). Damage
   resolution order is `(base + damageBonus) × (1 + damagePercent) ×
typedPrimaryMultiplier`, then crit.
4. **The old generic `stores.stats.damage` base is gone.** Every spell's
   damage output is now an explicitly authored `{base, scalesWithIntelligence:
true}` (computed from the historical `STAT_BASE.damage(10) ×
damagePercent`, so a fresh character's spell damage is unchanged from
   before the overhaul), resolved through the shared helper and then run
   through the generic offense step at damage resolution. A repo-wide
   deterministic scan (`tests/unit/no-legacy-stats-store-remains.test.ts`)
   asserts zero `stores.stats` reads remain under `src/`.
5. **Damage takes a typed, fail-closed options object, not positionals.**
   `applyDamage(world, target, amount, x, y, options: DamageOptions)` where
   `DamageOptions = { origin: 'player'|'enemy'|'environment', affinity:
'physical'|'magic'|'unscaled', scaleWithPrimary: boolean, canCrit: boolean,
...vfx/source fields }`. Only `origin === 'player'` damage against an
   `Enemy` (never a `Player`) target gets the generic-offense + optional
   typed-primary + optional crit treatment — closing the target-shape-gated
   bug above. Numeric zero decodes to `'environment'`/`'unscaled'`/`false`/
   `false` (fail-closed). A persisted `DamageMeta` ECS store
   (`core/damage-meta.ts`, fail-closed zero-decode, auto-cleared by the
   existing generic entity-recycle store clearing) carries this metadata onto
   delayed damage-bearing entities (player projectiles, `AreaDamage`
   explosions from traps/AoE-on-impact) that a single collision system
   resolves generically across weapon types; melee swings/beams/instant
   spell hits tag inline at their one dispatch choke point
   (`weaponSystem.dispatchAttackInner`, keyed off `WeaponType.MAGIC`).
   Corpse-burst and spawner early-return ordering, and player dodge
   (independent of `options`, gated only on the target being `Player`), are
   unchanged.
6. **Every spell numeric output is inline `{base, scalesWithIntelligence}`**
   (damage, healing, duration, radius, knockback, slow, etc.), resolved once
   through `resolveScalableOutput`/`resolveScalableOutputRounded` — the SAME
   `INT_MAGIC_STRENGTH_RATE` (+1%/effective point) a magic weapon's typed
   multiplier uses, so a magic weapon and a spell see byte-identical
   post-gear scaling (`tests/unit/magic-scaling-parity.test.ts`). A spell's
   damage packet then applies the generic offense step with `scaleWithPrimary:
false` (the INT scaling already happened) but `canCrit: true`. Life-drain
   heals resolve from their OWN authored base+flag at the same effective INT,
   independent of damage dealt.
7. **Spell unlock gating is untouched; every mana-shaped surface is deleted**
   rather than neutered: world `playerMp`/`playerMaxMp`, `shared/mana.ts`,
   `manaSystem` (+ its lab/pipeline wiring), `mpCost` (schema, data,
   presentation, gating, spending), the HUD mana bar/layout row, the
   mana-flask consumable, and the `mana-efficiency` skill perk (renamed
   `arcane-efficiency`, same mechanical effect). `featureUnlocks.spells`
   gating is preserved exactly — abilities are unlock + cooldown gated only.
   A recursive deterministic source scan
   (`tests/unit/no-mana-remains.test.ts`) guards against regression.
8. **Weapon cadence and movement keep exact, guarded formulas.**
   `applyAttackSpeedAndCooldownReduction(baseCooldownMs, attackSpeedBonus,
cooldownReduction) = baseCooldownMs / (1 + max(-0.9, attackSpeedBonus)) ×
(1 - cooldownReduction)`, a single rounding pass at the end (no early
   rounding between factors). Ability cooldowns keep the pre-existing
   `applyCooldownReduction` (CDR only, no attack-speed factor) — its snapshot
   semantics are unchanged. `computeMoveSpeed = baseSpeed × (1 +
moveSpeedBonus) × statusMultiplier × encumbranceMultiplier` — status
   effects (haste/slow) fold in before encumbrance, which is always the last
   factor applied.
9. **Snapshot-only secondary fields stay for registry compatibility.**
   `pickupRange`/`projectileSpeed`/`projectileCount` remain `EffectiveStats`
   keys (some registries still reference them) but the obsolete INT→
   projectile-speed and LUCK→pickup-range derivations are removed — nothing
   currently writes non-zero values into them.
10. **Encumbrance is fully wired but currently inert.** `shared/encumbrance.ts`
    is pure band math: thresholds = body weight + 40/80/120 lb + 5 lb per
    effective Strength point; bands (inclusive upper bound) unburdened(×1) /
    encumbered(×0.85) / heavy(×0.70) / overloaded(×0.70).
    `core/encumbrance.ts` combines the ECS `Weight` component (body mass),
    deduped equipped-item weight (`computeEquippedWeightLb` — a multi-slot
    item's `weightLb` counts once, not once per occupied slot), and effective
    Strength. `EquipmentUI` now shows equipped weight / total mass / band.
    Every shipped `EquipmentItemDef` explicitly sets `weightLb: 0` (now a
    required field on the type), so real play is always in the unburdened
    (×1) band today — inert by data, not by code path (synthetic nonzero
    `weightLb` boundary/dedupe tests exercise every band).
11. **Default AI allocator branches only on offense stat, sharing everything
    else.** New sequence: Constitution → 8, Dexterity → 5, offense (Strength for a
    physical weapon, Intelligence for `WeaponType.MAGIC`) → 5,
    Wisdom → 5, offense → 11, Constitution for the remainder. Weapon personas
    (`game/ai/weapon-personas.ts`) stay disabled by default; only their
    compatibility with the new stat schema was verified, no new persona
    tuning was added.
12. **Labs updated, mana lab deleted.** `stats-lab`, `stat-lab`, `level-up-lab`,
    `abilities-lab` (and its `weapon-skill-lab`/`ux-snapshot-lab` neighbors)
    were updated to the new `initializeBaseStats` + core `statSystem`
    pipeline and the weightLb/mana-free schema; `src/labs/mana-lab/` and its
    `lab-main.ts` registration are deleted.
13. **This ADR supersedes** `2026-07-10-shared-stat-allocation-and-runtime-
derivations.md` (Strength `damagePercent` scaling, the `weight`
    placeholder), `0018-secondary-stats-into-combat.md` (the old
    `stores.stats`/`EffectiveStats` split and its Luck/Dexterity rates), and
    `0019-wisdom-mana-pool.md` (the mana pool this overhaul removes).

## Consequences

### Positive

- One stat pipeline (`EffectiveStats`) for the whole game — no more
  `stores.stats` vs `stores.effectiveStats` drift risk.
- Physical and magical offense are provably independent
  (`computeTypedPrimaryMultiplier`, parity-tested), so gearing/allocating one
  primary can never silently inflate the other's damage.
- The fail-closed `DamageOptions` contract closes a real latent bug (any hit
  on an Enemy previously inherited player crit/scaling regardless of source)
  and makes future damage sources (a new trap, a new enemy ability) safe by
  default — they must opt IN to scaling/crit, not opt out.
- Mana's full removal (rather than neutering) means no dead code, dead HUD
  real estate, or dead schema fields survive to confuse a future session —
  ability access is a single, simple unlock+cooldown gate.
- Encumbrance is real, tested infrastructure ready for the next content pass
  (non-zero `weightLb` items) without further plumbing.
- The default AI allocator now makes sane choices for a magic-weapon
  playthrough instead of always pumping Strength.

### Negative

- A large, mechanically-invasive diff across `shared/`, `core/`, `game/`,
  `engine/`, `labs/`, and the full test suite — the highest-risk kind of
  change to review and to keep behavior-neutral where intended (baseline HP,
  baseline spell damage).
- The `DamageMeta` persisted-metadata pattern adds one more ECS store and one
  more thing a NEW delayed damage-bearing entity type must remember to tag
  (mitigated by the fail-closed default: forgetting to tag never over-scales,
  it silently under-scales/under-crits, the safe failure direction).
- Encumbrance's move-speed effect is currently unobservable in real play
  (every shipped item is `weightLb: 0`), so its correctness rests entirely on
  synthetic unit/ECS tests until real item weights land.

### Risks

- Introducing/removing RNG draws anywhere in the damage/crit/dodge path
  (even indirectly, e.g. a new baseline Luck/Dexterity contribution now
  applying even with zero allocated points) shifts the seeded RNG stream for
  any test or sweep that depends on an exact crit/no-crit outcome at a fixed
  seed — several existing tests needed their expected values recomputed for
  this reason during implementation, and a future broad win-rate sweep should
  be watched for the same class of drift (expected to be within normal
  seed-to-seed variance, not a systemic balance regression).
- `pickupRange`/`projectileSpeed`/`projectileCount` remaining as inert
  snapshot fields could be mistaken for "wired" by a future reader; the doc
  comments on `SECONDARY_STATS` call this out explicitly.
- Encumbrance thresholds/bands are new gameplay math that has never been
  exercised by a real, non-zero item weight — first real content should
  re-verify the chosen band multipliers (0.85/0.70) feel right before relying
  on them for balance.

## Alternatives Considered

- **Dual-store adapter** (keep the legacy `Stats` component alongside
  `EffectiveStats`, bridging between them) — rejected; two stat surfaces for
  one character sheet is the exact drift risk this overhaul exists to close,
  and a bridge would only defer the unification.
- **Source-resolved damage** (infer scaling/crit eligibility by inspecting
  the source entity's components/team at the moment `applyDamage` runs,
  instead of a persisted/inline options object) — rejected; that is
  functionally the OLD target-shape-gated bug in a different shape (implicit
  inference instead of an explicit, fail-closed contract), and delayed
  entities (a projectile in flight) may outlive or move away from their
  source, making live re-inspection unreliable.
- **Persisted attack payloads via a side-map instead of an ECS store**
  (`Map<eid, DamageOptions>`) — rejected in favor of the `DamageMeta` typed
  ECS store; a side-map needs its own manual recycle-safe clearing on entity
  reuse, while the ECS store gets that for free from the existing generic
  `clearEntityStores` sweep.
- **A parallel per-ability scaling-rate table** (keyed by ability id, read by
  a shared resolver) instead of inline `{base, scalesWithIntelligence}` per
  numeric field — rejected; inline keeps each output's scaling decision next
  to its authored value in the registry (harder to forget/desync when
  someone adds a new spell field), matching the explicit human requirement
  that "every magical ability explicitly declares each numeric output's
  scaling."
- **Neuter mana instead of removing it** (zero out `mpCost` everywhere, hide
  the HUD bar, keep the rest of the plumbing dormant) — rejected per the
  explicit contract ("remove mana entirely... rather than leaving dead mana
  terminology"); dormant plumbing is exactly the kind of cruft that
  compounds and wastes future sessions' time re-discovering it's inert.
- **Split this into multiple PRs** (e.g., stat unification separate from
  mana removal separate from encumbrance) — rejected; the approved contract
  is a single, internally-consistent overhaul (e.g., the AI allocator's
  offense-key branch depends on the typed-primary split, which depends on
  `EffectiveStats` unification), and the maintainer's explicit direction was
  one PR covering the full contract.
- **Build vs. buy: adopt an external stat/RPG-math library** instead of
  custom pure helpers — rejected. The gameplay stat model here is a thin,
  fully bespoke contract (exact per-point rates, a typed-primary
  physical/magic split, fail-closed damage metadata threaded through a
  bitecs typed-array ECS) that no general-purpose stat library models
  out of the box; adopting one would mean writing an adapter layer at least
  as large as the ~200 lines of pure functions in `shared/stats.ts` while
  losing determinism guarantees (no library dependency to audit for hidden
  `Math.random()`/`Date.now()`) and fighting the library's own data model
  against bitecs's typed-array-per-field storage. The existing in-repo
  pattern — plain pure functions plus Zod for the one place data crosses a
  trust boundary (`game/abilities/registry.ts`'s catalog parsing) — already
  fits a deterministic, typed-array ECS precisely and needed no new
  dependency.
