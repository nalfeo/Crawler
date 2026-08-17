import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/game/ai/bt-ai-tuning.js';
import { PLAYER_PERSONAS, getPersonaConfig } from '../../src/game/ai/personas.js';

const LAB_SOURCE = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf-8');

describe('AI runner lab player-persona wiring', () => {
  it('exposes every player persona as a lab option', () => {
    // The dropdown is built from PLAYER_PERSONAS, so a persona added to the AI
    // module surfaces in the lab automatically instead of being lab-invisible.
    expect(LAB_SOURCE).toContain('PLAYER_PERSONAS.map((persona)');
    expect(LAB_SOURCE).toContain(".name('Player persona')");
    for (const persona of PLAYER_PERSONAS) {
      expect(LAB_SOURCE).toContain(`${persona}:`);
    }
  });

  it('applies the selected persona preset to the AI brain', () => {
    expect(LAB_SOURCE).toContain('...getPersonaConfig(aiConfig.playerPersona)');
  });

  it('rebuilds the AI brain and persists the choice when the persona changes', () => {
    // Anchor on the control's own `.name(...)` and stop at the next controller's
    // `.name(` so a formatter/whitespace change can never silently widen or empty
    // the slice (both asserted strings appear elsewhere in the file).
    const start = LAB_SOURCE.indexOf(".name('Player persona')");
    expect(start).toBeGreaterThan(-1);
    const end = LAB_SOURCE.indexOf('.name(', start + 1);
    expect(end).toBeGreaterThan(start);
    const controlBlock = LAB_SOURCE.slice(start, end);
    expect(controlBlock).toContain('rebuildAiBrain()');
    expect(controlBlock).toContain('persistLabState()');
  });

  it('persists the selected persona across lab reloads', () => {
    expect(LAB_SOURCE).toContain('playerPersona: aiConfig.playerPersona');
    expect(LAB_SOURCE).toContain('persisted?.aiConfig?.playerPersona');
    // An unrecognized persisted value must fall back to the production baseline
    // rather than being handed to getPersonaConfig (which would yield undefined).
    expect(LAB_SOURCE).toContain(
      'isPlayerPersona(persistedPersona) ? persistedPersona : DEFAULT_PLAYER_PERSONA',
    );
  });

  it('supports a ?persona=<id> deep link', () => {
    expect(LAB_SOURCE).toContain("new URLSearchParams(window.location.search).get('persona')");
    expect(LAB_SOURCE).toContain('const urlPersona = playerPersonaFromUrl();');
  });

  it('reports the active persona in the debug snapshot and telemetry strip', () => {
    expect(LAB_SOURCE).toContain('playerPersona: PlayerPersona;');
    expect(LAB_SOURCE).toContain('id="ai-player-persona"');
  });

  it('defaults to the production-equivalent persona so a fresh lab matches the shipped game', () => {
    expect(LAB_SOURCE).toContain(
      "const DEFAULT_PLAYER_PERSONA: PlayerPersona = 'experienced_player'",
    );
    const { seed: _seed, debug: _debug, ...tuning } = DEFAULT_CONFIG;
    expect(getPersonaConfig('experienced_player')).toEqual(tuning);
  });
});
