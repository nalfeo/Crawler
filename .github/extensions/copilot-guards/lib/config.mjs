// Shared helpers: config loading, env-var bypass.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let cachedConfig = null;
function loadConfig() {
    if (cachedConfig) return cachedConfig;
    try {
        const raw = readFileSync(join(here, "..", "config.json"), "utf-8");
        cachedConfig = JSON.parse(raw);
    } catch {
        cachedConfig = { guards: {} };
    }
    return cachedConfig;
}

function envDisabledSet() {
    const env = process.env.COPILOT_GUARDS_DISABLE || "";
    return new Set(
        env
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

export function isGuardEnabled(guardId) {
    const cfg = loadConfig();
    const guardCfg = cfg.guards?.[guardId];
    if (guardCfg?.disabled === true) return false;
    const env = envDisabledSet();
    if (env.has("*")) return false;
    if (env.has(guardId)) return false;
    return true;
}

export function guardSeverity(guardId, fallback = "deny") {
    const cfg = loadConfig();
    return cfg.guards?.[guardId]?.severity || fallback;
}

export function bypassReason(guardId) {
    const cfg = loadConfig();
    if (cfg.guards?.[guardId]?.disabled === true) return "disabled in config.json";
    const env = envDisabledSet();
    if (env.has("*")) return "COPILOT_GUARDS_DISABLE=* set";
    if (env.has(guardId)) return `COPILOT_GUARDS_DISABLE includes ${guardId}`;
    return null;
}

// For tests.
export function _resetConfigCache() {
    cachedConfig = null;
}
