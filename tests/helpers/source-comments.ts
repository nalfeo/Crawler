/**
 * Comment stripping for the deterministic source-scanning guards.
 *
 * The guards in `tests/unit/sprites/**` read TypeScript sources as text and
 * assert things about the CALL SITES they contain, so a function name mentioned
 * in prose inside a docstring must not be counted as a real call.
 *
 * Why this uses the TypeScript parser
 * -----------------------------------
 * Every cheaper approach silently WEAKENS the guards built on it, and a guard
 * that stops seeing its subject is worse than no guard because it buys false
 * confidence. Two were measured on this repo before landing on the parser:
 *
 *  1. `source.replace(/\/\*[\s\S]*?\*\//g, '')` — string literals like
 *     `'public/assets/generated/**'` contain a comment-opener sequence, which
 *     starts a phantom comment that runs to the next real terminator. On
 *     `scripts/sprites/sidecar/server.ts` this hid **~19KB** of source,
 *     including the entire `/accept` route — one of the exact bypasses the
 *     acceptance-routing guard exists to catch. It reported green throughout.
 *
 *  2. A hand-rolled character scanner tracking string/template/comment state —
 *     better, but it still desynced on the same file (a regex literal and a
 *     backtick inside a line comment were enough) and lost ~1700 lines,
 *     including one of the two call sites the concept guard counts.
 *
 * So this defers to `ts.createSourceFile`, the real parser, which already knows
 * how to tell a comment from a string, a template, a regex literal, and JSX.
 * Comment bytes are replaced with spaces — never deleted — so both byte offsets
 * and line numbers are identical to the input, and a token adjacent to a
 * comment cannot be glued to its neighbour.
 *
 * Pure and deterministic: no IO, no globals.
 */
import ts from 'typescript';

export function stripSourceComments(source: string): string {
  const sourceFile = ts.createSourceFile(
    'guard-scan.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // TypeScript reports offsets in UTF-16 code units. `split('')` preserves that
  // indexing; `[...source]` would collapse astral characters (for example emoji)
  // and shift every later comment range.
  const chars = source.split('');
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end && i < chars.length; i += 1) {
      // Keep newlines so reported line numbers still match the original file.
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };

  // Every byte belongs to some token's FULL range, and all trivia — whitespace
  // AND comments, leading or trailing — lives in the span between a token's
  // full start and its start. Blanking that whole span for every leaf token
  // therefore covers every comment exactly once, without having to reason about
  // TypeScript's leading-vs-trailing trivia classification (a same-line `//`
  // comment is TRAILING trivia of the previous token, so asking only for
  // leading ranges misses it).
  //
  // Blanking whitespace alongside comments is harmless: spaces stay spaces and
  // newlines are preserved, so offsets and line numbers are untouched.
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      blank(node.getFullStart(), node.getStart(sourceFile, /* includeJsDocComment */ false));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);

  return chars.join('');
}
