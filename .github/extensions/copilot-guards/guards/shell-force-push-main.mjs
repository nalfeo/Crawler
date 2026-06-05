// shell-force-push-main: block force pushes targeting main/master.
//
// Catches all the variants the rubber-duck flagged:
//   git push --force <... main ...>
//   git push -f <... main ...>
//   git push --force-with-lease=main
//   git push origin +main:main           (refspec '+' = force)
//   git push origin +master:master
//
// Also detects when the *current* HEAD is being pushed without an
// explicit refspec but with --force and `origin` — that pushes the
// current branch to its tracking target. We DON'T deny that case
// because we can't know without IO whether tracking is main. The
// agent's `git push --force` to a feature branch is fine.

import { isGit, normalizeCommand } from "../lib/shell.mjs";

const PROTECTED_BRANCHES = ["main", "master"];

function segmentDeniesForceMain(seg) {
    if (!isGit(seg)) return null;
    if (!/\bpush\b/.test(seg)) return null;

    const forceUsed =
        /(^|\s)(-f|--force(?![-\w])|--force=true|--force-with-lease(=[^\s]*)?|--force-if-includes)\b/.test(
            seg,
        );

    // Refspec form: `+main:...` or `+refs/heads/main:...` (rare) — '+' makes
    // it a force push regardless of --force flag. The optional `refs/heads/`
    // prefix is the fully-qualified ref form and must not be missed.
    const refspecForce = PROTECTED_BRANCHES.some((b) =>
        new RegExp(`\\s\\+(?:refs/heads/)?${b}(:|\\s|$)`).test(seg),
    );

    if (!forceUsed && !refspecForce) return null;

    const targetsProtected = PROTECTED_BRANCHES.some((b) =>
        new RegExp(`(^|[\\s:+/])${b}([\\s:+]|$)`).test(seg),
    );

    if (targetsProtected || refspecForce) {
        return `Refusing to force-push to a protected branch (main/master). Detected segment: \`${seg}\`. If you really need to do this, run it manually outside the agent — this guard never allows it.`;
    }
    return null;
}

export default {
    id: "shell-force-push-main",
    category: "shell",
    failClosed: true,
    matches(toolName, toolArgs) {
        if (toolName !== "powershell" && toolName !== "bash") return false;
        const cmd = String(toolArgs?.command || "");
        return /\bpush\b/.test(cmd) && /\b(main|master)\b/.test(cmd);
    },
    check(toolArgs) {
        const cmd = String(toolArgs?.command || "");
        for (const seg of normalizeCommand(cmd)) {
            const reason = segmentDeniesForceMain(seg);
            if (reason) return { decision: "deny", reason };
        }
        return { decision: "allow" };
    },
};
