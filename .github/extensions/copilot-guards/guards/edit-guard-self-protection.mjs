// edit-guard-self-protection: prompt before edits to the guard
// extension itself. Prevents an agent from quietly disabling
// enforcement by editing config.json or a guard file.
//
// Severity is 'ask' (not 'deny') because legitimate maintenance is
// expected. The env var COPILOT_GUARDS_EDIT=1 short-circuits to allow
// when actively developing the extension (this very PR uses it).

const SELF_PATH_RE = /^\.github[\\/]extensions[\\/]copilot-guards[\\/]/;

function normalizePath(p) {
    return String(p || "").replace(/\\/g, "/");
}

export default {
    id: "edit-guard-self-protection",
    category: "edit",
    failClosed: false,
    matches(toolName, toolArgs) {
        if (toolName !== "edit" && toolName !== "create") return false;
        const path = normalizePath(toolArgs?.path);
        return SELF_PATH_RE.test(path);
    },
    check(toolArgs) {
        const path = normalizePath(toolArgs?.path);
        if (process.env.COPILOT_GUARDS_EDIT === "1") {
            return {
                decision: "allow",
                additionalContext: `Note: editing the guard extension (${path}) is allowed because COPILOT_GUARDS_EDIT=1 is set.`,
            };
        }
        return {
            decision: "ask",
            reason: `About to modify the convention-enforcement extension itself (${path}). Confirm this is intentional. To skip this prompt while developing the extension, set COPILOT_GUARDS_EDIT=1.`,
        };
    },
};

export { SELF_PATH_RE, normalizePath };
