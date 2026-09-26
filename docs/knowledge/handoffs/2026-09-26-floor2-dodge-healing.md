# Floor 2 signatures, dodge priority, boss clearance, and healing potions

## Systems touched

ai-behavior-tree, ai-combat-balance, weapons, enemies, loot, item-pickup,
mob-abilities, combat-arena-lab, main-scene-probe-lab, vfx

## Scope and decisions

User requested active telegraph dodging, no center-charging into large bosses,
and 1% regular / 50% boss healing potion drops restoring 10% maximum health.
Drops are Floor 2 only. Existing Health Vial entities heal on collision, cap at
maximum HP, and remain on the ground at full health or after player death.

Producer coordination adopted Game AI Engineer for steering, Systems Engineer
for existing ECS drop/pickup plumbing, and a bounded melee implementation slice.
ADR [0112](../adr/0112-floor2-dodge-and-recovery.md) records the seams.

The user then explicitly approved enabling specials and implementing the ten
missing signatures. Producer decomposition was READY (confidence 0.9, no DAG
validation errors or human routing corrections). Systems Engineer slices owned
four lane abilities, four ring/sweep abilities, and two utility abilities;
activation depended on those three slices. Main adopted Game AI Engineer and
Graphics Designer for public geometry consumers. Existing bitecs execution,
owned effects, and combat-arena lab were reused; no new framework or ECS system.

## Completed plan

1. Implement the ten approved catalog signatures in typed handlers.
2. Extend public annulus/composite/sweep geometry and sampled owned hazards;
   AI and rendering consume the same state. Preserve Floor 4 ring semantics.
3. Register only unlocked, entered dens. Activate the global runtime once;
   subsequent encounters cannot reset another caster's clock or hazards.
4. Prove all 18 repeat casts and cleanup in the production pipeline and retain
   the unchanged contiguous seeds 1–3 victory and boss-duration gate.
5. Run full-diff Ducky plus independent review, local validation, and publish a
   ready-for-review PR, then release to CI Recovery and the merge train.

Tiebreakers: determinism, independent verification, safe parallelism. The
critical path was typed geometry → AI/render integration → production evidence.
No human restructuring or gameplay requirement relaxation was needed.

## Behavior and evidence

- Previously, final pursuit/smoothing could dilute public-geometry dodging;
  circles ignored player extent and radial-spoke dodge pointed toward the lane.
  New final-input tests cover outward motion, body overlap, spoke sides,
  overlapping circles, mixed lane/circle priority, two enemy bodies, and walls.
  Wall-blocked lane/projectile escapes select the open side using the retained
  threat trajectory. Contact checks and melee orbits match the collision grid's
  actual AABB footprint, including diagonals for radius-based boss bodies.
- Floor 2 melee now hits physical enemy surfaces for player-owned swings only.
  A real core-pipeline regression damages a large enemy from outside contact;
  the Floor 1 control retains prior center-only behavior. Grid/full-scan and
  repeated runs match HP, positions, frames, and RNG.
  A 180-frame diagonal-approach regression proves the AI lands hits without
  taking contact damage in the real core pipeline.
- Potion tests cover exact probability boundaries, duplicate deaths/pickups,
  capped/fractional healing, full/dead preservation, other-floor isolation,
  same-seed replay, and death-to-pickup through the real core pipeline.
- Normal Floor 2 seed 1 playthrough before final multi-hazard review corrections:
  victory at frame 51,956 (865.9s), four bosses and exit completed, 341 kills,
  267 damage taken, minimum HP 91%, final HP 100%. Boss fights 15–21s.
  This is viability evidence, not a broad difficulty or fun claim.
- Signatures: charge, thorn annulus, sequential sonic bands, defensive shell,
  alternating full sweep, burrow eruption, recoverable robbery, Rattled cone,
  persistent fire line, and contracting slime ring. Rocco's stolen currency is
  restitution, not new income. Summoned rats inherit the caster's run-local
  family index and are removed when the caster dies.
- The all-roster headless contract runs five four-family configurations through
  the real objective and simulation pipeline, observing two public warnings,
  two actual casts, and normal death cleanup for every signature. Boosted HP in
  these contract fixtures is observation-only, not balance evidence.
- Normal seeds 1–3 pass victory, exit completion, actual signature resolution,
  catalog-derived minimum fight duration, and the unchanged 45-second ceiling.
  Ability activation alone resolved the previous seed-2 duration failure; boss
  HP was not raised. This is bounded viability evidence, not a broad fun claim.
- Fast verification passed 331 files / 4,241 tests before the final Honk and
  summon regressions; final publication checks are recorded in the PR.
- Final browser verification: eight tests across the new geometry/MainGameScene
  suite and existing King Skritt/Don Paco arena suites. Same-state pixel checks
  isolate warning and active-zone graphics, not just announcement banners.
  Screenshots in `tmp/e2e-screenshots/floor2-*.png` show ring safe holes, ordered
  bands, sweep direction, and the persistent burrow endpoint circle. The real
  Seed 42 Scorch den exposed dim warnings under lighting; shared danger depths
  801/802 now sit above darkness and below the UI-camera cutoff 900. Before/after
  screenshots retain `floor2-production-signature-warning-before-depth.png`
  and `floor2-production-signature-warning.png`.

## Previous blocker resolved

Before signature activation, the survival gate completed all seeds with victory, but
seed 2's goblin boss died in 8,883ms, below its required 9,250ms signature cycle
(encounter start 861,483ms; defeat 870,367ms; player level 20). Seeds 1 and 3
passed all assertions. The threshold was not weakened and boss health was not
changed. The user approved implementation of all remaining abilities and
production activation. With those abilities active, the unchanged gate passes;
no durability adjustment was necessary.

## Review and handoff

Independent design review identified the melee hit/spacing seam and spoke-sign
bug. Independent post-diff review identified sequential body corrections and
circle rescoring overriding lane/projectile escape; both received fixes and
final-input regressions. Ducky identified wall-blocked escape and the contact
geometry mismatch; both are fixed and regression-tested. Fresh full-diff Ducky
review originally passed with 36 focused tests. For the expanded signature scope,
both reviewers found Honk applying secondary effects after an avoided hit;
the damage-result guard and Invincible/guaranteed-dodge tests fix it. Independent
re-review is clean. Ducky's second pass found Grubbs losing its endpoint warning
during travel and metrics counting unrecovered robbery money as spendable.
The committed endpoint remains public through eruption, the burst occurs at
actual impact, and balance reconstructions subtract outstanding theft; focused
and real-browser regressions pass. Ducky's own
sandboxed preflight stalled at browser-cache access; the main session's elevated
preflight completed successfully. Final gate outcomes are recorded in the PR.
Final full-diff Ducky review found no actionable bugs and passed 121 focused
tests in 11 files. Independent final-delta review passed 57 tests in four files
with no blocking or medium findings. Review passed; the change is okay to check in.
Global handoff lint reports a pre-existing unrelated missing retrospective in
`2026-09-26-merge-train-synchronize-reevaluation.md`; it was not altered. Our
handoff, documentation paths, and ADR consistency checks have no findings.
After ready-for-review publication, CI Recovery and the merge train own follow-up;
do not arm auto-merge or keep this session waiting for CI.

## Retrospective

### Lessons Learned

Production activation needs per-caster registration, not repeated global
activation. Public hazards must persist through delayed impact, not disappear
when the telegraph timer ends. Real rendering revealed darkness obscuring cues
that looked correct in the brighter arena.

### Mistakes Made

The first new Honk handler ignored the damage result for secondary effects;
the first burrow active state discarded its endpoint circle; the first robbery
ledger change omitted headless balance reconstruction. Reviews found all three,
and each now has focused regression coverage.

### Opportunities for Future Improvement

Use the all-roster production contract test for future boss changes, while
keeping normal unmodified AI survival tests separate from fixture-based casts.
Broad balance/fun sweeps remain GitHub-backed work, not a claim from three seeds.
