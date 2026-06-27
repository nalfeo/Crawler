import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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

  it('redraws the full light field after clearing the render texture', () => {
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
    expect(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer)).toBe(
      true,
    );
    expect(declaration?.initializer?.getText(file)).not.toContain('dirtyRect');
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
});
