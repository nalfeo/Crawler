import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  LIGHTING_OVERLAY_DEPTH,
  PROP_DEPTH,
  UI_DEPTH_CUTOFF,
  WORLD_VFX_DEPTH,
} from '../../src/shared/render-depths.js';

const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');
const file = ts.createSourceFile(
  'MainGameScene.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function findSceneMethod(name: string): ts.MethodDeclaration {
  let found: ts.MethodDeclaration | undefined;
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== 'MainGameScene') continue;
    for (const member of statement.members) {
      if (ts.isMethodDeclaration(member) && member.name.getText(file) === name) {
        found = member;
        break;
      }
    }
  }
  if (!found) {
    throw new Error(`MainGameScene.${name} not found`);
  }
  return found;
}

function getTopLevelCallNames(method: ts.MethodDeclaration): string[] {
  return (method.body?.statements ?? [])
    .map((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
        return null;
      }
      const expression = statement.expression.expression;
      return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
    })
    .filter((name): name is string => name !== null);
}

describe('MainGameScene lighting overlay behavior', () => {
  it('computes initial FOV before first lighting overlay draw in create()', () => {
    const createMethod = findSceneMethod('create');
    const body = createMethod.body?.getText(file) ?? '';
    // Initial FOV is computed via the perf-timed wrapper (behavior-identical to
    // calling fovSystem(world) directly, but records the lab granularity EWMA).
    const initialFovIndex = body.indexOf('this.runFovSystemWithPerf(this.world);');
    const initialLightingDrawIndex = body.indexOf('this.updateLightingOverlay(true);');

    expect(initialFovIndex).toBeGreaterThanOrEqual(0);
    expect(initialLightingDrawIndex).toBeGreaterThanOrEqual(0);
    expect(initialFovIndex).toBeLessThan(initialLightingDrawIndex);
  });

  it('refreshes the lighting overlay in the normal playing sync path', () => {
    const updateMethod = findSceneMethod('update');
    const callNames = getTopLevelCallNames(updateMethod);
    const hasNormalSyncSequence = callNames.some(
      (_name, index) =>
        callNames[index] === 'updateDoorOverlay' &&
        callNames[index + 1] === 'updateLightingOverlay' &&
        callNames[index + 2] === 'sync',
    );

    expect(hasNormalSyncSequence).toBe(true);
  });

  it('redraws only the camera-scoped lighting window after clearing the render texture', () => {
    const method = findSceneMethod('updateLightingOverlay');
    const boundsDeclaration = (method.body?.statements ?? []).find((statement) => {
      if (!ts.isVariableStatement(statement)) return false;
      return statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(file) === 'bounds',
      );
    });

    expect(boundsDeclaration).toBeDefined();
    expect(ts.isVariableStatement(boundsDeclaration!)).toBe(true);
    const declaration = (
      boundsDeclaration as ts.VariableStatement
    ).declarationList.declarations.find((entry) => entry.name.getText(file) === 'bounds');
    expect(declaration?.initializer && ts.isIdentifier(declaration.initializer)).toBe(true);
    expect(declaration?.initializer?.getText(file)).toBe('viewRect');
  });

  it('does not use frame-throttle skip when the lighting view rect changed', () => {
    const method = findSceneMethod('updateLightingOverlay');
    const body = method.body?.getText(file) ?? '';
    const shouldSkipIndex = body.indexOf('const shouldSkip');
    const skipConditionIndex = body.indexOf('&&\n      viewRectUnchanged;');

    expect(shouldSkipIndex).toBeGreaterThanOrEqual(0);
    expect(skipConditionIndex).toBeGreaterThanOrEqual(0);
    expect(skipConditionIndex).toBeGreaterThan(shouldSkipIndex);
  });

  it('clears the lighting-dirty flag before the auto-quality rebuild block', () => {
    // Regression guard: auto-quality runs setLightingConfig() ->
    // rebuildLightField(), which sets lightingDirty = true to force a full
    // recompute of the freshly reallocated field. If the method cleared
    // lightingDirty = false *after* that block it would drop the signal and
    // leave most of the map black until the next floor load. The reset must
    // therefore come before the auto-quality logic.
    const method = findSceneMethod('updateLightingOverlay');
    const body = method.body?.getText(file) ?? '';
    const resetIndex = body.indexOf('this.lightingDirty = false');
    const autoQualityIndex = body.indexOf('autoAdjustQuality');

    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(autoQualityIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeLessThan(autoQualityIndex);
  });

  it('draws the darkness overlay above gameplay sprites but below the HUD', () => {
    // Regression guard: the overlay must sit above props, entities and VFX so
    // torch falloff dims mobs/NPCs/props — not just the floor — while staying
    // below the screen-space UI cutoff so the HUD reads through the dark.
    const maxVfx = Math.max(...Object.values(WORLD_VFX_DEPTH));
    expect(LIGHTING_OVERLAY_DEPTH).toBeGreaterThan(PROP_DEPTH.front);
    expect(LIGHTING_OVERLAY_DEPTH).toBeGreaterThan(maxVfx);
    expect(LIGHTING_OVERLAY_DEPTH).toBeLessThan(UI_DEPTH_CUTOFF);
  });

  it('renders the light overlay render-texture at LIGHTING_OVERLAY_DEPTH', () => {
    expect(source).toContain('.setDepth(LIGHTING_OVERLAY_DEPTH)');
  });

  it('collects harvestable and set-piece light emitters for the light field', () => {
    expect(source).toContain('query(this.world.ecs, [Harvestable, Position])');
    expect(source).toContain('for (const setPieceProp of this.world.setPieceProps)');
    expect(source).toContain('/^prop-wall-sconce-var-\\d+$/.test(spriteId)');
    expect(source).toContain('/^prop-lantern-var-\\d+$/.test(spriteId)');
    expect(source).toContain('/^prop-torch-var-\\d+$/.test(spriteId)');
  });

  it('includes secondary light-source membership in the stationary cache key', () => {
    expect(source).toContain('const secondarySourcesKey = secondarySourceKeyParts.join');
    expect(source).toContain('this.lightingLastSecondarySourcesKey === secondarySourcesKey');
    expect(source).toContain('this.lightingLastSecondarySourcesKey = secondarySourcesKey');
  });
});
