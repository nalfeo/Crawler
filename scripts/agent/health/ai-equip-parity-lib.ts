/**
 * Library half of the AI equipment-parity guard — see
 * `check-ai-equip-parity.ts` for the rationale. Split out so the scan is unit
 * testable without spawning a process or asserting on exit codes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Equipment mutators that accept an `{ force }` option to skip the safe-context gate. */
export const EQUIPMENT_MUTATORS: readonly string[] = [
  'equipFromBag',
  'equip',
  'unequip',
  'claimGeneratedEquipmentRewardBundle',
];

/**
 * AI-path files permitted to force an equipment mutation. Empty by design: an
 * entry here is an explicit, reviewed statement that the AI may do something a
 * human player cannot. Never add one merely to make this check pass.
 */
export const ALLOWLIST: readonly string[] = [];

export interface ForceEquipViolation {
  /** Repo-relative POSIX path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The offending source line, trimmed. */
  readonly snippet: string;
}

export interface ForceEquipScanResult {
  readonly violations: readonly ForceEquipViolation[];
  readonly scannedFiles: number;
}

function listTypeScriptFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Scan `root` (normally `src/game/ai`) for equipment mutator calls that pass a
 * `force` option.
 *
 * The scan follows complete call expressions and local option-object references
 * so normal multiline formatting, aliases, and object spreads cannot hide a
 * force bypass. `repoRelativeTo` controls the reported path prefix so callers
 * can report repo-relative paths from any cwd.
 */
export function findAiForceEquipViolations(
  root: string,
  repoRelativeTo: string = path.resolve(root, '..', '..', '..'),
): ForceEquipScanResult {
  const violations: ForceEquipViolation[] = [];
  const files = listTypeScriptFiles(root);

  for (const file of files) {
    const relative = path.relative(repoRelativeTo, file).split(path.sep).join('/');
    if (ALLOWLIST.includes(relative)) {
      continue;
    }
    const sourceText = readFileSync(file, 'utf8');
    const lines = sourceText.split(/\r?\n/);
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const initializers = new Map<string, ts.Expression>();

    const collectInitializers = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        initializers.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collectInitializers);
    };
    collectInitializers(source);

    const containsForceOption = (expression: ts.Expression, seen: Set<string>): boolean => {
      if (ts.isIdentifier(expression)) {
        if (seen.has(expression.text)) return false;
        const initializer = initializers.get(expression.text);
        if (!initializer) return expression.text === 'force';
        const nextSeen = new Set(seen);
        nextSeen.add(expression.text);
        return containsForceOption(initializer, nextSeen);
      }
      if (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isNonNullExpression(expression) ||
        ts.isSatisfiesExpression(expression)
      ) {
        return containsForceOption(expression.expression, seen);
      }
      if (ts.isObjectLiteralExpression(expression)) {
        return expression.properties.some((property) => {
          if (ts.isSpreadAssignment(property)) {
            return containsForceOption(property.expression, seen);
          }
          if (ts.isShorthandPropertyAssignment(property)) {
            return property.name.text === 'force';
          }
          if (ts.isPropertyAssignment(property)) {
            const name =
              ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
                ? property.name.text
                : null;
            return name === 'force' && property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
          }
          return false;
        });
      }
      let found = false;
      ts.forEachChild(expression, (child) => {
        if (!found && ts.isExpression(child)) {
          found = containsForceOption(child, seen);
        }
      });
      return found;
    };

    const visitCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const calleeName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null;
        if (
          calleeName !== null &&
          EQUIPMENT_MUTATORS.includes(calleeName) &&
          node.arguments.some((argument) => containsForceOption(argument, new Set()))
        ) {
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push({
            file: relative,
            line: location.line + 1,
            snippet: (lines[location.line] ?? '').trim(),
          });
        }
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(source);
  }

  return { violations, scannedFiles: files.length };
}
