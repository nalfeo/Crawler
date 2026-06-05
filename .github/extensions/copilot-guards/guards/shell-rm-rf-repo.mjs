// shell-rm-rf-repo: block recursive deletion targeting the repo root
// or git-tracked paths above the cwd. We're permissive about deletes
// inside node_modules, dist, build artifacts.
//
// The intent is to stop "rm -rf .", "Remove-Item . -Recurse -Force",
// and similar repo-wiping commands. We don't try to be a full FS
// safety net — that's what backups are for.

import { isProgram, normalizeCommand, tokenize } from "../lib/shell.mjs";

const SAFE_TARGET_PREFIXES = ["node_modules", "dist", "build", "coverage", ".vite", "tmp"];

function isDangerousTarget(target) {
    if (!target) return false;
    const raw = target.replace(/\\/g, "/");
    if (raw === "." || raw === "./" || raw === "/" || raw === "*" || raw === "./*") return true;
    const t = raw.replace(/^\.\//, "");
    if (t === ".." || t.startsWith("../")) return true;
    if (t.startsWith("~")) return true;
    if (t.startsWith("/")) return true; // absolute path
    if (/^[a-zA-Z]:[\\/]?$/.test(target)) return true; // C:\ etc
    // Targeting a known repo root subdir is fine; anything else is suspect
    // only if it's at the root. We deny if it's a simple name AND not in
    // the safe list AND not obviously a temp.
    return false;
}

function segmentDeniesRmRf(seg) {
    if (isProgram(seg, "rm")) {
        const tokens = tokenize(seg);
        // Look for -r/-R/-rf/-fr style flag
        const hasRecursive = tokens.some((t) => /^-[a-zA-Z]*[rR]/.test(t));
        if (!hasRecursive) return null;
        const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
        for (const tgt of targets) {
            if (isDangerousTarget(tgt)) {
                return `Refusing recursive delete targeting '${tgt}'. Segment: \`${seg}\`. Use targeted paths (e.g. node_modules, dist).`;
            }
        }
    }
    if (isProgram(seg, "Remove-Item") || isProgram(seg, "ri") || isProgram(seg, "rm")) {
        // PowerShell: Remove-Item -Recurse -Force <path>
        if (/-Recurse\b/i.test(seg) && /-Force\b/i.test(seg)) {
            const tokens = tokenize(seg);
            const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
            for (const tgt of targets) {
                if (isDangerousTarget(tgt)) {
                    return `Refusing recursive delete targeting '${tgt}'. Segment: \`${seg}\`.`;
                }
            }
        }
    }
    return null;
}

export default {
    id: "shell-rm-rf-repo",
    category: "shell",
    failClosed: true,
    matches(toolName, toolArgs) {
        if (toolName !== "powershell" && toolName !== "bash") return false;
        const cmd = String(toolArgs?.command || "");
        return /\b(rm|Remove-Item|ri)\b/.test(cmd) && /(-r|-R|-Recurse|-rf|-fr)/.test(cmd);
    },
    check(toolArgs) {
        const cmd = String(toolArgs?.command || "");
        for (const seg of normalizeCommand(cmd)) {
            const reason = segmentDeniesRmRf(seg);
            if (reason) return { decision: "deny", reason };
        }
        return { decision: "allow" };
    },
};

// Exported for tests.
export { isDangerousTarget, segmentDeniesRmRf, SAFE_TARGET_PREFIXES };
