/**
 * Regression coverage for the AI Runner lab's reload-required feature-flag
 * wiring (`attackWaves` / `floor1Spawners`): distinct selected vs applied
 * snapshots, the pending-reload UI marker, applicability-driven control
 * disabling, and the single "Apply staged + restart" / "↻ Restart" seam that
 * actually applies a staged selection.
 *
 * These are source-text assertions (matching the existing convention in
 * `ai-runner-run-settings-wiring.test.ts`) rather than a full DOM/Phaser
 * render, since this lab's other wiring tests use the same style. End-to-end
 * runtime behavior (the flags actually reaching `world.attackWaveFlags` /
 * Floor 1's static spawners) is covered by
 * `tests/headless/attack-waves-floor1-spawners-flags.test.ts`, which exercises
 * the exact same `configureAttackWaves` / `ScenarioInitializationOptions`
 * seam this lab wires through `createFloorMainSceneOptions`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/labs/ai-runner-lab/index.ts', 'utf8');

describe('AI Runner lab — reload-required feature-flag wiring', () => {
  it('keeps a distinct selected (featureFlags) vs applied (appliedFeatureFlags) snapshot', () => {
    expect(SOURCE).toContain('let appliedFeatureFlags: AiFeatureFlags = { ...featureFlags };');
    expect(SOURCE).toContain('function hasPendingFeatureFlagReload(): boolean {');
    expect(SOURCE).toContain(
      'control.reloadRequired && featureFlags[control.key] !== appliedFeatureFlags[control.key]',
    );
  });

  it('threads appliedFeatureFlags through the single ScenarioInitializationOptions seam', () => {
    expect(SOURCE).toContain(
      'function scenarioInitializationOptionsFromApplied(): ScenarioInitializationOptions {',
    );
    expect(SOURCE).toContain('attackWaves: appliedFeatureFlags.attackWaves,');
    expect(SOURCE).toContain('floor1Spawners: appliedFeatureFlags.floor1Spawners,');
    // Every createFloorMainSceneOptions call site in this lab forwards it —
    // no parallel/ad-hoc flag path.
    const callSiteCount = (SOURCE.match(/createFloorMainSceneOptions\(/g) ?? []).length;
    const forwardedCount = (
      SOURCE.match(
        /createFloorMainSceneOptions\(currentFloor, scenarioInitializationOptionsFromApplied\(\)\)/g,
      ) ?? []
    ).length;
    expect(callSiteCount).toBeGreaterThan(0);
    expect(forwardedCount).toBe(callSiteCount);
  });

  it('only "Apply staged + restart" and "↻ Restart" (via applyRunSettings) promote a selection to applied', () => {
    // applyRunSettings is the sole seam that copies the live selection into
    // the applied snapshot — no competing restart path exists.
    expect(SOURCE).toContain('appliedFeatureFlags = { ...featureFlags };');
    const applyRunSettingsBody = SOURCE.slice(
      SOURCE.indexOf('const applyRunSettings = (next: {'),
      SOURCE.indexOf('const encodeFloorRunTarget'),
    );
    expect(applyRunSettingsBody).toContain('appliedFeatureFlags = { ...featureFlags };');
    expect(applyRunSettingsBody).toContain('updateFeatureFlagControllerState();');
    // Both buttons call applyRunSettings — no second/parallel apply path.
    expect(SOURCE).toContain('id="ai-run-apply"');
    expect(SOURCE).toContain('id="ai-restart-current"');
  });

  it('visibly marks a pending reload and clears once selected matches applied', () => {
    expect(SOURCE).toContain('id="ai-feature-flag-reload-note"');
    expect(SOURCE).toContain("hasPendingFeatureFlagReload() ? '' : ' hidden'");
    expect(SOURCE).toContain('Apply staged + restart" (or ↻ Restart) to apply it.');
  });

  it('marks attackWaves and floor1Spawners reload-required in the canonical registry, driving the folder split', () => {
    // The registry (not the lab) owns which flags are reload-required; the
    // lab reads `control.reloadRequired` generically rather than
    // hardcoding key names.
    expect(SOURCE).toContain('for (const control of getAiFeatureFlagControls()) {');
    expect(SOURCE).not.toContain("control.key === 'attackWaves'");
    expect(SOURCE).not.toContain("control.key === 'floor1Spawners'");
  });

  it('disables and relabels feature-flag controls inapplicable to the current floor/scenario target', () => {
    expect(SOURCE).toContain('function updateFeatureFlagControllerState(): void {');
    expect(SOURCE).toContain('isAiFeatureFlagApplicable(control.key, context)');
    expect(SOURCE).toContain('controller.disable(!applicable);');
    expect(SOURCE).toContain("' (n/a for this scenario preset)'");
    expect(SOURCE).toContain('` (n/a on ${currentFloor})`');
    // Recomputed whenever the applied floor/scenario changes.
    const applyRunSettingsBody = SOURCE.slice(
      SOURCE.indexOf('const applyRunSettings = (next: {'),
      SOURCE.indexOf('const encodeFloorRunTarget'),
    );
    expect(applyRunSettingsBody).toContain('updateFeatureFlagControllerState();');
    expect(SOURCE).toContain('recomposeFloorTransitionOptions: (nextFloorOptions) => {');
    const recomposeBody = SOURCE.slice(
      SOURCE.indexOf('recomposeFloorTransitionOptions: (nextFloorOptions) => {'),
      SOURCE.indexOf('recomposeFloorTransitionOptions: (nextFloorOptions) => {') + 1200,
    );
    expect(recomposeBody).toContain('updateFeatureFlagControllerState();');
  });

  it('bases applicability context on the applied (not staged) floor/scenario target', () => {
    expect(SOURCE).toContain('function aiFeatureFlagContext(): AiFeatureFlagContext {');
    expect(SOURCE).toContain(
      'isRealFloorTarget: selectedScenarioPresetId === DEFAULT_AI_RUNNER_SCENARIO_PRESET_ID,',
    );
  });

  it('preserves legacy aiConfig feature-flag fields as read-only migration compatibility', () => {
    expect(SOURCE).toContain('@deprecated Legacy read-only migration field');
    // The canonical write path (persistLabState) must not re-serialize the
    // deprecated fields back under aiConfig.
    const persistLabStateBody = SOURCE.slice(
      SOURCE.indexOf('const persistLabState = (): void => {'),
      SOURCE.indexOf('const persistLabState = (): void => {') + 800,
    );
    expect(persistLabStateBody).not.toContain('weaponPersonas:');
    expect(persistLabStateBody).not.toContain('optionalPurchases:');
    expect(persistLabStateBody).not.toContain('settlementReturnRouting:');
    expect(persistLabStateBody).toContain('featureFlags: { ...featureFlags },');
  });
});
