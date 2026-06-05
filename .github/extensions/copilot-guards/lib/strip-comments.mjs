// Strip JS/TS line and block comments and (optionally) string literals
// from source so simple textual checks don't false-positive on
// `Math.random()` appearing in a comment or a docstring — and conversely,
// don't false-negative when forbidden code hides inside a template-literal
// expression like `${require('phaser')}`.
//
// This is a lexer, not a parser. It handles:
//   - `// line comments` to end of line
//   - `/* block comments */`
//   - `'single'`, `"double"`, and `` `template` `` strings, with `\` escapes
//   - template literal `${ ... }` expressions, recursively, with correct
//     nested-brace tracking (object literals, blocks, nested templates)
//
// Not handled: regex literals (they're treated as code; false-positive
// risk is negligible for our guards).
//
// Two exported helpers:
//   - stripCommentsOnly  → drop comments, keep string literal content
//                          (and keep code inside `${...}` expressions
//                          so it can still be scanned for forbidden imports)
//   - stripCommentsAndStrings → drop comments and string content, keep
//                               code inside `${...}` expressions

export function stripCommentsOnly(src) {
  return scan(src, /* stripStrings */ false);
}

export function stripCommentsAndStrings(src) {
  return scan(src, /* stripStrings */ true);
}

function scan(src, stripStrings) {
  if (typeof src !== 'string' || src.length === 0) return '';
  const ctx = { src, i: 0, n: src.length, out: '', stripStrings };
  scanCode(ctx, /* stopOnUnmatchedBrace */ false);
  return ctx.out;
}

// Scan code until end of input, or until we hit an unmatched `}` when
// `stopOnUnmatchedBrace` is true (used to terminate a `${...}` expression).
function scanCode(ctx, stopOnUnmatchedBrace) {
  const { src, n } = ctx;
  let braceDepth = 0;
  while (ctx.i < n) {
    const ch = src[ctx.i];
    const next = src[ctx.i + 1];

    if (ch === '/' && next === '/') {
      while (ctx.i < n && src[ctx.i] !== '\n') ctx.i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      ctx.i += 2;
      while (ctx.i < n && !(src[ctx.i] === '*' && src[ctx.i + 1] === '/')) ctx.i++;
      ctx.i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      scanQuotedString(ctx, ch);
      continue;
    }
    if (ch === '`') {
      scanTemplate(ctx);
      continue;
    }
    if (stopOnUnmatchedBrace) {
      if (ch === '{') {
        braceDepth++;
        ctx.out += '{';
        ctx.i++;
        continue;
      }
      if (ch === '}') {
        if (braceDepth === 0) return; // closes the enclosing ${...}
        braceDepth--;
        ctx.out += '}';
        ctx.i++;
        continue;
      }
    }
    ctx.out += ch;
    ctx.i++;
  }
}

function scanQuotedString(ctx, quote) {
  const { src, n, stripStrings } = ctx;
  if (!stripStrings) ctx.out += quote;
  ctx.i++;
  while (ctx.i < n && src[ctx.i] !== quote) {
    if (src[ctx.i] === '\\' && ctx.i + 1 < n) {
      if (!stripStrings) ctx.out += src[ctx.i] + src[ctx.i + 1];
      ctx.i += 2;
      continue;
    }
    if (!stripStrings) ctx.out += src[ctx.i];
    ctx.i++;
  }
  if (ctx.i < n) {
    if (!stripStrings) ctx.out += quote;
    ctx.i++;
  }
}

function scanTemplate(ctx) {
  const { src, n, stripStrings } = ctx;
  if (!stripStrings) ctx.out += '`';
  ctx.i++; // past opening backtick
  while (ctx.i < n) {
    const ch = src[ctx.i];
    if (ch === '`') {
      if (!stripStrings) ctx.out += '`';
      ctx.i++;
      return;
    }
    if (ch === '\\' && ctx.i + 1 < n) {
      if (!stripStrings) ctx.out += src[ctx.i] + src[ctx.i + 1];
      ctx.i += 2;
      continue;
    }
    if (ch === '$' && src[ctx.i + 1] === '{') {
      ctx.out += '${';
      ctx.i += 2;
      // Body is JS code. Recursively scan, stripping comments (and
      // strings if stripStrings), tracking nested braces so an
      // object literal `{a:1}` or block doesn't prematurely close
      // the expression.
      scanCode(ctx, /* stopOnUnmatchedBrace */ true);
      // scanCode returns when it hits the matching `}`; emit it.
      if (ctx.i < n && src[ctx.i] === '}') {
        ctx.out += '}';
        ctx.i++;
      }
      continue;
    }
    // Plain template character — keep or drop per stripStrings.
    if (!stripStrings) ctx.out += ch;
    ctx.i++;
  }
}
