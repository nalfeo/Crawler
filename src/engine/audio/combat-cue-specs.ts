/**
 * combat-cue-specs — pure mapping from a decided combat/loot audio cue (see
 * `src/shared/combat-audio-cues.ts`) to concrete oscillator/gain synth
 * parameters for `AudioCueEngine`. No `AudioContext`, no `Date.now()`, no
 * `Math.random()` — a plain function of the cue.
 *
 * Lives beside `audio-cue-engine.ts` (rather than inside
 * `src/engine/combat-audio.ts`) so the spec table has a real production
 * importer and a name that does not collide with
 * `reward-opening-audio.ts`'s own `synthSpecForCue`.
 */
import type { CombatAudioCue } from '../../shared/combat-audio-cues.js';
import type { SynthCueSpec } from './audio-cue-engine.js';

export function combatSynthSpecForCue(cue: CombatAudioCue): SynthCueSpec {
  const intensity = cue.intensity;
  switch (cue.kind) {
    case 'weaponHit':
      return {
        waveform: 'square',
        frequencyHz: 180 + intensity * 120,
        durationMs: 70,
        gain: 0.08 + intensity * 0.1,
        label: 'combat:weapon-hit',
      };
    case 'weaponCrit':
      return {
        waveform: 'sawtooth',
        frequencyHz: 260 + intensity * 220,
        glideToHz: 180,
        durationMs: 120,
        gain: 0.12 + intensity * 0.16,
        label: 'combat:weapon-crit',
      };
    case 'weaponMiss':
      return {
        waveform: 'sine',
        frequencyHz: 300,
        glideToHz: 160,
        durationMs: 90,
        gain: 0.06,
        label: 'combat:weapon-miss',
      };
    case 'damageTaken':
      return {
        waveform: 'triangle',
        frequencyHz: 160 - intensity * 40,
        glideToHz: 90,
        durationMs: 140,
        gain: 0.14 + intensity * 0.18,
        label: 'combat:damage-taken',
      };
    case 'blocked':
      return {
        waveform: 'square',
        frequencyHz: 420,
        glideToHz: 320,
        durationMs: 90,
        gain: 0.12,
        label: 'combat:blocked',
      };
    case 'dodge':
      return {
        waveform: 'sine',
        frequencyHz: 500,
        glideToHz: 700,
        durationMs: 100,
        gain: 0.1,
        label: 'combat:dodge',
      };
    case 'enemyDeath':
      return {
        waveform: 'sawtooth',
        frequencyHz: 220 + intensity * 80,
        glideToHz: 60,
        durationMs: 180,
        gain: 0.14 + intensity * 0.14,
        label: 'combat:enemy-death',
      };
    case 'spellCast':
      return {
        waveform: 'triangle',
        frequencyHz: 300 + intensity * 180,
        glideToHz: 480 + intensity * 220,
        durationMs: 260,
        gain: 0.12 + intensity * 0.18,
        label: 'combat:spell-cast',
      };
    // A spell/ability landing on a target: same triangle timbre family as the
    // cast that produced it (so the two read as one action), but shorter and
    // falling rather than rising, so an impact is never confused with a cast
    // — and never with a weapon hit's square-wave thud.
    case 'spellImpact':
      return {
        waveform: 'triangle',
        frequencyHz: 420 + intensity * 220,
        glideToHz: 240,
        durationMs: 120,
        gain: 0.1 + intensity * 0.14,
        label: 'combat:spell-impact',
      };
    case 'abilityActivate':
      return {
        waveform: 'square',
        frequencyHz: 400 + intensity * 200,
        glideToHz: 600 + intensity * 260,
        durationMs: 200,
        gain: 0.1 + intensity * 0.14,
        label: 'combat:ability-activate',
      };
    case 'pickup':
      return {
        waveform: 'triangle',
        frequencyHz: 640,
        glideToHz: 820,
        durationMs: 110,
        gain: 0.1,
        label: 'combat:pickup',
      };
  }
}
