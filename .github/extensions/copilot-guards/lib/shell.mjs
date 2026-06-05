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
// Strip a wrapper like `bash -c "..."`, `pwsh -NoProfile -Command "..."`,
// or `bash -lc "..."`. Allows any number of intermediate flag tokens
// between the program and the command flag.
const WRAPPER_RE = /^\s*(?:bash|sh|pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z][\w-]*)*\s+(?:-c\b|-Command\b|-lc\b|-ic\b|-lic\b|-li\b)\s+/i;

export function normalizeCommand(raw) {
    if (typeof raw !== "string" || raw.length === 0) return [];
    let s = raw.replace(LINE_CONT_RE, " ");
    s = s.replace(WRAPPER_RE, "");
    // After stripping a `bash -c "..."` wrapper, the remaining command is
    // typically wrapped in a matched pair of quotes. Strip them so
    // tokenize() can see the inner program. Without this, the inner
    // command collapses to a single quoted token and `isGit`/`isGh`
    // never matches — a trivial bypass for every shell guard.
    s = s.trim();
    // If what's left starts with a quote, find the matching close (respecting
    // `\` escapes) and use the content between the quotes as the command body.
    // This handles `bash -c "git push ..." -- arg0` where there are trailing
    // args after the closed quote — without this, the closing quote isn't at
    // the very end and the old "both ends quoted" check leaves the inner
    // command quoted, defeating tokenize/isGit.
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
        const quote = s[0];
        let j = 1;
        while (j < s.length) {
            if (s[j] === "\\" && j + 1 < s.length) {
                j += 2;
                continue;
            }
            if (s[j] === quote) break;
            j++;
        }
        if (j < s.length) {
            s = s.slice(1, j);
        }
    }

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
