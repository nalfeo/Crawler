# Mob Motion Lab

Open `lab.html?lab=mob-motion-lab` to compare six deterministic visual treatments
on approved generated enemy art:

- **Spawn:** the shared pop, wiggle, and settle treatment.
- **Movement:** stride, hop, hover, slither, or stomp based on enemy family.
- **Attack:** anticipation and recovery, plus the runtime telegraph timing and
  hostile fireball sprite for ranged archetypes. Both the locked telegraph and
  projectile begin at the mob's visual pivot, matching the runtime ECS origin.
- **Hit reaction:** recoil, shake, compression, fade, and white flash.
- **Death / corpse:** the runtime kill pop and knockback handoff, rising skull,
  persistent blood pool, and shared three-second corpse grey/fade curve.
- **Status:** cycling freeze, burn, and stun visual concepts. These are presentation
  studies, not declarations of canonical gameplay statuses.

Choose a runtime enemy archetype first, then select any approved art variant wired
to that archetype. Shared art remains separated by archetype, so a ranged enemy can
show its projectile without making a melee enemy that uses the same sprite appear
ranged. Motion speed, intensity, preview scale, and deterministic scrub time are
adjustable with lil-gui. The preview uses manifest hold and center-of-gravity
anchors when available.
