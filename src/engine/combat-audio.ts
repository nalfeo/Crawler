/**
 * combat-audio — engine-layer glue that turns three already-existing,
 * authoritative event queues into procedurally synthesized `AudioCueEngine`
 * playback, via the pure decision logic in `src/shared/combat-audio-cues.ts`.
 *
 * Covers the issue's five categories (weapons, spells, abilities, damage
 * taken, loot pickups) WITHOUT any new core/game plumbing: every event this
 * module reacts to is already pushed every tick by `damageSystem.ts` /
 * `apply-damage.ts` / `weaponSystem.ts` / `abilitySystem.ts` /
 * `skillSystem.ts` / `itemPickupSystem.ts` for the existing VFX renderers
 * (`EffectsVfx`, `CombatVfx`) to consume.
 *
 * Sources (see `combat-audio-cues.ts`'s doc comment for why each was picked):
 * - `world.combatEvents` → weapon hit/crit/miss, spell/ability impact, damage
 *   taken, blocked, dodge, enemy death. Authoritative (this queue already
 *   carries `amount`/`isCrit`/`targetType`/`fromActiveAbility`, not merely
 *   cosmetic) — `fromActiveAbility` is what separates a spell landing from a
 *   weapon strike, so ability damage never plays weapon SFX.
 * - `world.abilityActivations` → spell cast / ability activate. Authoritative
 *   "a player active/spell ability fired" signal — NOT `vfxEvents`' cosmetic
 *   spell-cast/ability-flash VFX kinds, which also fire for passive
 *   re-activation and carry no semantic contract.
 * - `world.vfxEvents` (`pickupSparkle` only) → loot pickup. No authoritative
 *   pickup-type queue exists, so this is the one place this module still
 *   reads a cosmetic queue — deliberately reduced to a single generic cue
 *   (never inferring pickup TYPE from tint; see `combat-audio-cues.ts`).
 *
 * Ownership/read model — mirrors `EffectsVfx.ts` exactly, NOT
 * `reward-opening-audio.ts`'s hook-driven model, because this module's input
 * is per-frame event QUEUES rather than discrete UI callbacks. All three
 * queues are READ but NOT drained here — `CombatVfx` is the sole drainer of
 * `combatEvents` AND `abilityActivations`; `EffectsVfx` is the sole drainer of
 * `vfxEvents`. This module must therefore run BEFORE both `combatVfx.update()`
 * and `effectsVfx.update()` in the same frame (enforced by call-site ordering
 * in `PhaserBridge.ts`, mirroring the comment already there documenting
 * `effectsVfx`'s own combatEvents read-before-drain requirement). Because
 * this module never mutates any of the three queues, wiring it in is purely
 * additive — it cannot itself break `EffectsVfx`/`CombatVfx`'s drain
 * contracts. `tests/e2e/combat-audio-real-wiring.test.ts` locks this ordering
 * against the REAL booted `MainGameScene` + `PhaserBridge` frame loop (it
 * pushes onto the real queues and asserts the cue still fires on the next
 * real frame, which is only possible if this module runs before the
 * drainers), rather than relying on comments or a hand-rolled call order.
 *
 * Per-frame arbitration: `AudioCueEngine` has no built-in voice cap/pooling
 * beyond `stopAll()`, and a single frame can carry many DIFFERENT-kind events
 * at once (an AoE spell that casts, hits a dozen enemies, and kills several,
 * all in the same tick). Two throttles combine so a bursty frame reads as
 * one clear, prioritized beat instead of a wall of overlapping oscillators:
 * 1. A per-kind cooldown (`MIN_GAP_MS_BY_KIND`, keyed on the render clock —
 *    never `Date.now()`) throttles REPEATS of the same kind.
 * 2. A per-frame cue budget (`MAX_CUES_PER_FRAME`) caps how many DISTINCT
 *    kinds may play in one `update()` call, keeping only the
 *    highest-`CUE_PRIORITY` candidates (damage taken and enemy death
 *    outrank a generic weapon hit, which outranks a pickup chime) — a
 *    same-tick swarm of low-priority hits can never bury the one moment that
 *    actually matters (the player getting hurt, or a kill). A cue dropped
 *    only by the per-frame budget (not by its own cooldown) does NOT update
 *    its cooldown timer, so it can still win priority on a later, quieter
 *    frame instead of being penalized for losing this one.
 *
 * Safe no-audio fallback: identical to `reward-opening-audio.ts` — every
 * call is a plain `engine.play()`, which itself never throws when
 * unavailable (headless test runners, no `AudioContext`, autoplay-blocked).
 * This module owns its own `AudioCueEngine` instance, separate from
 * `reward-opening-audio.ts`'s — `AudioCueEngine.stopAll()`/`dispose()` are
 * instance-scoped by design (see `audio-cue-engine.ts`'s doc comment), so
 * sharing one instance across two unrelated feature owners would let one
 * feature's cancellation (e.g. reward-opening's skip/close) silence the
 * other's in-flight cues. Two independent `AudioContext`s are cheap and
 * browsers do not meaningfully limit them for this use case.
 */
import {
  cueForAbilityActivation,
  cueForCombatEvent,
  cueForVfxEvent,
  type CombatAudioCue,
  type CombatAudioCueKind,
} from '../shared/combat-audio-cues.js';
import type { AbilityActivationEvent } from '../shared/ability-activation-events.js';
import type { CombatEvent } from '../shared/combat-events.js';
import type { VfxEvent } from '../shared/vfx-events.js';
import type { GameWorld } from '../core/world.js';
import type { AudioCueEngine } from './audio/audio-cue-engine.js';
import { combatSynthSpecForCue } from './audio/combat-cue-specs.js';

/**
 * Minimum gap (ms, render clock) between two cues of the SAME kind. Tuned per
 * kind: high-frequency combat spam (weapon hits) gets a short window so
 * rapid-fire attacks still feel responsive; rarer/louder events (spell casts,
 * ability activations, damage taken) get a longer window so they read as
 * distinct beats instead of a stutter.
 */
const MIN_GAP_MS_BY_KIND: Record<CombatAudioCueKind, number> = {
  weaponHit: 50,
  weaponCrit: 70,
  weaponMiss: 120,
  damageTaken: 150,
  blocked: 150,
  dodge: 150,
  enemyDeath: 80,
  spellCast: 150,
  spellImpact: 80,
  abilityActivate: 150,
  pickup: 50,
};

/**
 * Playback priority when more DISTINCT kinds fire in one frame than
 * `MAX_CUES_PER_FRAME` allows. Higher wins. Player-danger signals (getting
 * hit, dying-adjacent) and the "something big just happened" beats
 * (crit/kill/spell/ability) rank above routine weapon noise and pickups.
 */
const CUE_PRIORITY: Record<CombatAudioCueKind, number> = {
  damageTaken: 100,
  enemyDeath: 90,
  weaponCrit: 80,
  spellCast: 70,
  abilityActivate: 65,
  spellImpact: 62,
  blocked: 60,
  dodge: 55,
  weaponHit: 40,
  weaponMiss: 20,
  pickup: 10,
};

/** Max distinct cue kinds played per `update()` call — see module doc comment. */
const MAX_CUES_PER_FRAME = 4;

export interface CombatAudioController {
  /** Read this frame's event queues (without draining any of them) and play any throttled-through cues. */
  update(world: GameWorld, renderElapsedMs: number): void;
  /** Stop all in-flight voices and release the underlying `AudioContext`. Unusable after this. */
  destroy(): void;
}

/**
 * Creates a controller bound to one `AudioCueEngine`. `renderElapsedMs` is
 * always passed in by the caller each frame, exactly like `EffectsVfx.update()`
 * — this module never touches `Date.now()`.
 */
export function createCombatAudio(engine: AudioCueEngine): CombatAudioController {
  const lastPlayedMs = new Map<CombatAudioCueKind, number>();

  return {
    update(world: GameWorld, renderElapsedMs: number): void {
      const candidates: CombatAudioCue[] = [];

      // Read-only — CombatVfx is the sole drainer of combatEvents.
      for (const event of world.combatEvents as readonly CombatEvent[]) {
        const cue = cueForCombatEvent(event);
        if (cue) candidates.push(cue);
      }
      // Read-only — CombatVfx is the sole drainer of abilityActivations.
      for (const event of world.abilityActivations as readonly AbilityActivationEvent[]) {
        candidates.push(cueForAbilityActivation(event));
      }
      // Read-only — EffectsVfx is the sole drainer of vfxEvents.
      for (const event of world.vfxEvents as readonly VfxEvent[]) {
        const cue = cueForVfxEvent(event);
        if (cue) candidates.push(cue);
      }

      if (candidates.length === 0) return;

      // Per-kind cooldown first: only the FIRST candidate per kind this
      // frame is even eligible, and only if its cooldown has elapsed. When
      // multiple same-kind candidates land in the same frame (e.g. an AoE
      // hit landing on several enemies), keep the highest-intensity one
      // rather than whichever happened to iterate first — otherwise a
      // low-intensity graze appearing earlier in `world.combatEvents` could
      // silently mask a much harder hit later in the same frame.
      const eligibleByKind = new Map<CombatAudioCueKind, CombatAudioCue>();
      for (const cue of candidates) {
        const existing = eligibleByKind.get(cue.kind);
        if (existing && existing.intensity >= cue.intensity) continue;
        const last = lastPlayedMs.get(cue.kind) ?? -Infinity;
        if (renderElapsedMs - last < MIN_GAP_MS_BY_KIND[cue.kind]) continue;
        eligibleByKind.set(cue.kind, cue);
      }
      if (eligibleByKind.size === 0) return;

      // Per-frame budget: keep only the highest-priority distinct kinds.
      const eligible = [...eligibleByKind.values()].sort(
        (a, b) => CUE_PRIORITY[b.kind] - CUE_PRIORITY[a.kind],
      );
      const toPlay = eligible.slice(0, MAX_CUES_PER_FRAME);

      for (const cue of toPlay) {
        lastPlayedMs.set(cue.kind, renderElapsedMs);
        engine.play(combatSynthSpecForCue(cue));
      }
    },
    destroy(): void {
      engine.stopAll();
      engine.dispose();
    },
  };
}
