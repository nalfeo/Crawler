// edit-repo-md-junk: block stray .md files outside the allowlist.
//
// AGENTS.md says: don't create markdown files in the repo for planning,
// notes, or tracking — use the session artifacts folder.
//
// Allowlist (per rubber-duck review):
//   - root: README.md, AGENTS.md, CONTRIBUTING.md, LICENSE.md,
//           SECURITY.md, CHANGELOG.md, CODE_OF_CONDUCT.md
//   - docs/**
//   - .github/**/*.md
//   - .specify/**
//   - src/labs/**/{README,SPEC}.md
//   - public/assets/**/README.md
//
// Note: this guard only fires on `create`, not `edit`. Editing an
// existing .md file outside the allowlist is fine (probably someone
// else's pre-existing content); only adding new junk is blocked.

const ROOT_ALLOWED = new Set([
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "LICENSE.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
]);

function normalizePath(p) {
    return String(p || "").replace(/\\/g, "/");
}

function isAllowed(path) {
    if (!path.endsWith(".md")) return true;
    // Root-level file?
    if (!path.includes("/")) return ROOT_ALLOWED.has(path);
    if (path.startsWith("docs/")) return true;
    if (path.startsWith(".github/")) return true;
    if (path.startsWith(".specify/")) return true;
    if (path.startsWith("public/assets/") && path.endsWith("/README.md")) return true;
    if (path.startsWith("src/labs/")) {
        return /\/(README|SPEC)\.md$/.test(path);
    }
    return false;
}

export default {
    id: "edit-repo-md-junk",
    category: "edit",
    failClosed: false,
    matches(toolName, toolArgs) {
        if (toolName !== "create") return false;
        const path = normalizePath(toolArgs?.path);
        return path.endsWith(".md");
    },
    check(toolArgs) {
        const path = normalizePath(toolArgs?.path);
        if (isAllowed(path)) return { decision: "allow" };
        return {
            decision: "deny",
            reason: `Refusing to create '${path}'. New .md files in the repo are restricted to docs/**, .github/**, .specify/**, src/labs/**/{README,SPEC}.md, public/assets/**/README.md, and an explicit root allowlist (README/AGENTS/CONTRIBUTING/LICENSE/SECURITY/CHANGELOG/CODE_OF_CONDUCT). For session-scoped planning/notes, write to the session artifacts folder instead.`,
        };
    },
};

export { isAllowed, normalizePath, ROOT_ALLOWED };
