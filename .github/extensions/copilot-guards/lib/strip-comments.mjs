// Strip JS/TS line and block comments and string literals from source
// so simple textual checks don't false-positive on `Math.random()`
// appearing in a comment or a docstring.
//
// This is a lexer, not a parser. It handles:
//   - `// line comments` to end of line
//   - `/* block comments */`
//   - `'single'`, `"double"`, and `\`template\`` strings, with `\` escapes
//   - template literal `${...}` expressions are kept (recursion via depth)
//
// Not handled: regex literals (they're treated as code; false-positive
// risk is negligible for our guards).

/**
 * Strip only JS/TS comments (not strings). Useful when you need to
 * preserve string contents — e.g. detecting `import 'phaser'` where
 * the module name is itself a string literal.
 */
export function stripCommentsOnly(src) {
    if (typeof src !== "string" || src.length === 0) return "";
    let out = "";
    let i = 0;
    const n = src.length;
    while (i < n) {
        const ch = src[i];
        const next = src[i + 1];
        if (ch === "/" && next === "/") {
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        // Skip past whole string/template literals as a unit so a `//`
        // inside a string doesn't get treated as a comment start.
        if (ch === "'" || ch === '"' || ch === "`") {
            const quote = ch;
            out += ch;
            i++;
            while (i < n && src[i] !== quote) {
                if (src[i] === "\\") {
                    out += src[i] + (src[i + 1] || "");
                    i += 2;
                } else {
                    out += src[i];
                    i++;
                }
            }
            if (i < n) {
                out += src[i];
                i++;
            }
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

export function stripCommentsAndStrings(src) {
    if (typeof src !== "string" || src.length === 0) return "";
    let out = "";
    let i = 0;
    const n = src.length;

    while (i < n) {
        const ch = src[i];
        const next = src[i + 1];

        // Line comment
        if (ch === "/" && next === "/") {
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        // Block comment
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        // String: single or double quote
        if (ch === "'" || ch === '"') {
            const quote = ch;
            i++;
            while (i < n && src[i] !== quote) {
                if (src[i] === "\\") i += 2;
                else i++;
            }
            i++;
            continue;
        }
        // Template literal
        if (ch === "`") {
            i++;
            let depth = 0;
            while (i < n) {
                if (depth === 0 && src[i] === "`") {
                    i++;
                    break;
                }
                if (src[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (src[i] === "$" && src[i + 1] === "{") {
                    depth++;
                    out += "${";
                    i += 2;
                    continue;
                }
                if (depth > 0 && src[i] === "}") {
                    depth--;
                    out += "}";
                    i++;
                    continue;
                }
                // Inside ${...}: copy through so guards still see Math.random()
                // inside template expressions. Outside: drop.
                if (depth > 0) {
                    out += src[i];
                }
                i++;
            }
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
