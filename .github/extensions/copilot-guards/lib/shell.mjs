// Shell command normalization + matchers shared by shell-* guards.
//
// Goal: make it hard to trivially bypass regex matches via whitespace,
// quoting, line continuations, or command chaining.

const LINE_CONT_RE = /[`\\]\r?\n[ \t]*/g; // PowerShell backtick or bash backslash
const WHITESPACE_RE = /[ \t]+/g;

/**
 * Normalize a raw shell command string. Returns an array of "segments"
 * — each segment is one command in a chain, with whitespace collapsed.
 */
export function normalizeCommand(raw) {
    if (typeof raw !== "string" || raw.length === 0) return [];
    let s = raw.replace(LINE_CONT_RE, " ");
    s = s.replace(/^\s*(bash|sh|pwsh|powershell)(\.exe)?\s+(-c|-Command|-NoProfile|--)\s+/i, "");

    const rawSegments = s.split(/(?:&&|\|\||;|\r?\n|(?<![|])\|(?!\|))/);

    return rawSegments
        .map((seg) => seg.trim().replace(WHITESPACE_RE, " "))
        .filter(Boolean);
}

export function anySegment(raw, predicate) {
    return normalizeCommand(raw).some(predicate);
}

/**
 * Tokenize a single shell segment into tokens, respecting simple
 * single/double quoting.
 */
export function tokenize(segment) {
    const tokens = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                cur += ch;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === " " || ch === "\t") {
            if (cur) {
                tokens.push(cur);
                cur = "";
            }
        } else {
            cur += ch;
        }
    }
    if (cur) tokens.push(cur);
    return tokens;
}

/**
 * Return true iff the segment invokes the named program (with optional
 * `.exe` suffix or path prefix).
 */
export function isProgram(segment, name) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) return false;
    const prog = tokens[0].toLowerCase().replace(/\\/g, "/");
    const base = prog.split("/").pop() || prog;
    return base === name.toLowerCase() || base === `${name.toLowerCase()}.exe`;
}

/**
 * Match `gh` (with optional .exe / path).
 */
export function isGh(segment) {
    return isProgram(segment, "gh");
}

/**
 * Match `git` (with optional .exe / path).
 */
export function isGit(segment) {
    return isProgram(segment, "git");
}
