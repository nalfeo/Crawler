import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Intentional canary tests: these follow the existing ai-runner wiring guards
// that read the source file and assert critical integration strings. The
// real-runtime behavior itself is proven by
// `tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`, which
// this file is not a substitute for — it only guards against the specific
// wiring regressing silently (source deleted/renamed/detached from the
// render loop) between real-e2e runs.
describe('AI runner companion decision/path parity (regression, #4205 review)', () => {
  const source = readFileSync(
    new URL('../../src/labs/ai-runner-lab/index.ts', import.meta.url),
    'utf-8',
  );

  it('renders a visible Decision-telemetry cell for companion state, not just internal debug-snapshot/overlay geometry', () => {
    // The reviewer's finding: `getCompanionTelemetry()`/`drawCompanionOverlay()`
    // alone are not a "readable UI surface" — a canvas-drawn line and an
    // internal `window.__aiRunnerDebug()` snapshot field are not something a
    // user looking at the panel (as opposed to a test harness) can read.
    expect(source).toContain('id="ai-companions-block"');
    expect(source).toContain('<strong>Companions:</strong> <span id="ai-companions">-</span>');
  });

  it('populates the companions cell from the same telemetry the overlay draws, every render tick', () => {
    expect(source).toContain("document.getElementById('ai-companions')");
    expect(source).toContain('const companions = world ? getCompanionTelemetry(world) : [];');
    expect(source).toMatch(/pt path/);
  });
});

describe('AI runner Floor 3 loss-reason classification (regression, #4205 review)', () => {
  const source = readFileSync(
    new URL('../../src/labs/ai-runner-lab/index.ts', import.meta.url),
    'utf-8',
  );

  it('gates the loss reason on Floor 3, matching the doc comment ("or is on a different floor")', () => {
    expect(source).toContain(
      "if (world.floorId !== 'floor3' || world.state !== 'game_over') return null;",
    );
  });

  it('checks the dead-player HP predicate before the party-wipe predicate', () => {
    // A simultaneous player-death + party-wipe frame must classify as the
    // player's own HP reaching zero, not fall through to 'party-wiped' —
    // player-hp is the more specific cause and healthSystem.ts sets
    // world.state = 'game_over' directly off it.
    const playerHpCheckIndex = source.indexOf("if (playerHealth <= 0) return 'player-hp';");
    const partyWipedCheckIndex = source.indexOf("if (_isPartyWiped(world)) return 'party-wiped';");
    expect(playerHpCheckIndex).toBeGreaterThan(-1);
    expect(partyWipedCheckIndex).toBeGreaterThan(-1);
    expect(playerHpCheckIndex).toBeLessThan(partyWipedCheckIndex);
  });
});
