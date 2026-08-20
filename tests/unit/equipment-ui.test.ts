import { beforeAll, describe, expect, it } from 'vitest';

// Source-text architectural guards for EquipmentUI's integrated-bag wheel-scroll.
//
// The integrated bag column can overflow its visible rows (BAG_COLS=4), so a
// wheel listener is the only affordance that keeps overflow items reachable in
// the real game (MainGameScene never calls scrollBag directly). These guards
// lock in the wiring + lifecycle and — critically — the HiDPI coordinate-space
// conversion, which a lab-only e2e (booted at renderScale S=1) cannot catch.
// Pixel-level scroll behaviour lives in tests/e2e/inventory-flow.test.ts.
describe('EquipmentUI bag-scroll architectural guard', () => {
  let source: string;
  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    source = (readFileSync as (path: string, encoding: string) => string)(
      'src/engine/EquipmentUI.ts',
      'utf-8',
    );
  });

  it('registers a wheel listener so the integrated bag column is scrollable', () => {
    expect(source).toContain("scene.input.on('wheel', handleWheel);");
  });

  it('unsubscribes from the wheel event on destroy to prevent listener leaks', () => {
    expect(source).toContain("scene.input.off('wheel', handleWheel);");
  });

  it('converts the wheel pointer to design space before hit-testing the bag (HiDPI)', () => {
    // Phaser pointer coords are in backing-store space (`[0, design × S]` after
    // the #353 supersample) while bagBg.getBounds() is design space. Without the
    // `/ getRenderScale(scene)` conversion the wheel misses the bag on any HiDPI
    // display (S >= 2 — the common case) and fires over an unrelated centre
    // region. Identity at S=1. Mirrors HudMinimap.toDesignSpace.
    expect(source).toContain("import { getRenderScale } from './render-scale.js';");
    expect(source).toContain('const s = getRenderScale(scene);');
    expect(source).toContain('bagBg.getBounds(), pointer.x / s, pointer.y / s');
  });

  it('guards the wheel handler so it only scrolls a visible, overflowing bag', () => {
    expect(source).toContain('if (!visible || bagMaxScroll <= 0 || deltaY === 0) return;');
  });

  it('clamps the bag scroll row to the last render range', () => {
    expect(source).toContain(
      'const next = Math.min(bagMaxScroll, Math.max(0, bagScrollRow + rows));',
    );
  });

  it('does not re-add generated equipment that core unequip already moved to the bag', () => {
    expect(source).toContain('if (!result.bagUpdated)');
  });

  it('resolves generated equipment through the world registry for render and dirty checks', () => {
    expect(source.match(/resolveEquipmentInstance\(lastWorld, state, instId\)/g)).toHaveLength(3);
    expect(source).toContain('itemDef ?? instance.def');
    expect(source).toContain('showGeneratedEquipmentTooltip(instance.def)');
    expect(source).toContain('getItemById(swapped.id)?.name ?? swapped.name');
  });

  it('keeps comparison deltas in the candidate tooltip instead of the stats pane', () => {
    expect(source).toContain('renderTooltipPair');
    expect(source).toContain("'Current totals'");
    expect(source).not.toContain('value + delta');
    expect(source).not.toContain('(${delta > 0 ?');
  });
});
