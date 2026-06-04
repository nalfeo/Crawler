// HTML renderer for the paper doll equipment viewer

import { SLOT_REGISTRY, PRIMARY_STATS, SECONDARY_STATS, STAT_LABELS, RARITY_COLORS, SLOT_ICONS } from "./data.mjs";

export function renderHtml(instanceId) {
    const slotBoxes = SLOT_REGISTRY.map(slot => {
        const left = (slot.uiPosition.x * 100).toFixed(1);
        const top = (slot.uiPosition.y * 100).toFixed(1);
        return `<div class="slot" id="slot-${slot.id}"
            style="left:${left}%;top:${top}%"
            data-slot="${slot.id}" title="${slot.label}">
            <span class="slot-icon">${SLOT_ICONS[slot.id] || "◻️"}</span>
            <span class="slot-label">${slot.label}</span>
        </div>`;
    }).join("\n");

    const primaryStatRows = PRIMARY_STATS.map(s =>
        `<div class="stat-row" id="stat-${s}">
            <span class="stat-label">${STAT_LABELS[s]}</span>
            <span class="stat-base" id="base-${s}">—</span>
            <span class="stat-arrow">→</span>
            <span class="stat-eff" id="eff-${s}">—</span>
        </div>`
    ).join("\n");

    const secondaryStatRows = SECONDARY_STATS.map(s =>
        `<div class="stat-row" id="stat-${s}">
            <span class="stat-label">${STAT_LABELS[s]}</span>
            <span class="stat-base" id="base-${s}">—</span>
            <span class="stat-arrow">→</span>
            <span class="stat-eff" id="eff-${s}">—</span>
        </div>`
    ).join("\n");

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Equipment Viewer</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    background: var(--background-color-default, #0d1117);
    color: var(--text-color-default, #e6edf3);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 14px);
    line-height: var(--leading-body-medium, 20px);
    display: flex;
    height: 100vh;
    overflow: hidden;
}
.panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
}
.header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color-default, #30363d);
    font-weight: var(--font-weight-semibold, 600);
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 8px;
}
.content {
    display: flex;
    flex: 1;
    overflow: hidden;
}
/* Paper doll area */
.doll-area {
    flex: 1;
    position: relative;
    min-width: 280px;
    padding: 16px;
}
.silhouette {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 60px;
    height: 160px;
    border: 2px dashed var(--border-color-default, #30363d);
    border-radius: 30px 30px 10px 10px;
    opacity: 0.3;
}
.slot {
    position: absolute;
    width: 56px;
    height: 56px;
    transform: translate(-50%, -50%);
    border: 2px solid var(--border-color-default, #30363d);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
    background: rgba(255,255,255,0.03);
    gap: 2px;
}
.slot:hover {
    border-color: var(--color-focus-outline, #58a6ff);
    background: rgba(88,166,255,0.08);
    transform: translate(-50%, -50%) scale(1.08);
    z-index: 10;
}
.slot.equipped {
    background: rgba(88,166,255,0.06);
}
.slot.equipped:hover {
    border-color: var(--true-color-red, #f85149);
    background: rgba(248,81,73,0.08);
}
.slot-icon { font-size: 18px; line-height: 1; }
.slot-label {
    font-size: 9px;
    color: var(--text-color-muted, #8b949e);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 52px;
}
.slot.equipped .slot-label {
    color: var(--text-color-default, #e6edf3);
    font-weight: 600;
}
/* Tooltip */
.tooltip {
    display: none;
    position: fixed;
    background: #161b22;
    border: 1px solid var(--border-color-default, #30363d);
    border-radius: 8px;
    padding: 10px 12px;
    z-index: 100;
    max-width: 220px;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.tooltip.visible { display: block; }
.tooltip-name { font-weight: 600; margin-bottom: 4px; }
.tooltip-rarity { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.tooltip-stat { font-size: 12px; color: #7ee787; margin: 1px 0; }
.tooltip-stat.negative { color: #f85149; }
/* Stat panel */
.stat-panel {
    width: 180px;
    border-left: 1px solid var(--border-color-default, #30363d);
    overflow-y: auto;
    padding: 12px;
}
.stat-section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-color-muted, #8b949e);
    margin: 12px 0 6px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border-color-default, #30363d);
}
.stat-section-title:first-child { margin-top: 0; }
.stat-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 0;
    font-size: 12px;
    font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
}
.stat-label {
    flex: 1;
    color: var(--text-color-muted, #8b949e);
    font-family: var(--font-sans, sans-serif);
    font-size: 12px;
}
.stat-base { min-width: 28px; text-align: right; }
.stat-arrow { color: var(--text-color-muted, #8b949e); font-size: 10px; }
.stat-eff { min-width: 28px; text-align: right; font-weight: 600; }
.stat-eff.positive { color: #7ee787; }
.stat-eff.negative { color: #f85149; }
/* Flash animation */
@keyframes flash-invalid {
    0%, 100% { border-color: var(--border-color-default, #30363d); }
    50% { border-color: var(--true-color-red, #f85149); background: rgba(248,81,73,0.15); }
}
.slot.flash { animation: flash-invalid 0.3s ease 2; }
</style>
</head>
<body>
<div class="panel">
    <div class="header">⚔️ Equipment</div>
    <div class="content">
        <div class="doll-area" id="doll-area">
            <div class="silhouette"></div>
            ${slotBoxes}
        </div>
        <div class="stat-panel">
            <div class="stat-section-title">Primary</div>
            ${primaryStatRows}
            <div class="stat-section-title">Secondary</div>
            ${secondaryStatRows}
        </div>
    </div>
</div>
<div class="tooltip" id="tooltip">
    <div class="tooltip-name" id="tooltip-name"></div>
    <div class="tooltip-rarity" id="tooltip-rarity"></div>
    <div class="tooltip-stats" id="tooltip-stats"></div>
</div>
<script>
const RARITY_COLORS = ${JSON.stringify(RARITY_COLORS)};
const STAT_LABELS = ${JSON.stringify(STAT_LABELS)};
const PRIMARY = ${JSON.stringify(PRIMARY_STATS)};
const SECONDARY = ${JSON.stringify(SECONDARY_STATS)};
const ALL_STATS = [...PRIMARY, ...SECONDARY];
const SLOT_ICONS = ${JSON.stringify(SLOT_ICONS)};

let state = null;

function formatStat(statId, value) {
    if (["critChance", "dodgeChance", "cooldownReduction", "xpBonus"].includes(statId)) {
        return (value * 100).toFixed(0) + "%";
    }
    if (["critMultiplier"].includes(statId)) return value.toFixed(1) + "×";
    if (["attackSpeed", "moveSpeed", "hpRegen"].includes(statId)) return value.toFixed(1);
    return Math.round(value).toString();
}

function updateUI() {
    if (!state) return;
    // Update slots
    document.querySelectorAll(".slot").forEach(el => {
        const slotId = el.dataset.slot;
        const instId = state.equipped[slotId];
        const iconEl = el.querySelector(".slot-icon");
        const labelEl = el.querySelector(".slot-label");

        if (instId !== null && state.instances[instId]) {
            const item = state.instances[instId].def;
            el.classList.add("equipped");
            el.style.borderColor = RARITY_COLORS[item.rarity] || "#9e9e9e";
            labelEl.textContent = item.name;
            iconEl.textContent = SLOT_ICONS[slotId] || "◻️";
        } else {
            el.classList.remove("equipped");
            el.style.borderColor = "";
            const reg = ${JSON.stringify(SLOT_REGISTRY)};
            const s = reg.find(r => r.id === slotId);
            labelEl.textContent = s ? s.label : slotId;
            iconEl.textContent = SLOT_ICONS[slotId] || "◻️";
        }
    });
    // Update stats
    for (const statId of ALL_STATS) {
        const base = state.baseStats[statId] ?? 0;
        const eff = state.effectiveStats[statId] ?? 0;
        const baseEl = document.getElementById("base-" + statId);
        const effEl = document.getElementById("eff-" + statId);
        if (baseEl) baseEl.textContent = formatStat(statId, base);
        if (effEl) {
            effEl.textContent = formatStat(statId, eff);
            effEl.className = "stat-eff" + (eff > base ? " positive" : eff < base ? " negative" : "");
        }
    }
}

// Tooltip
const tooltip = document.getElementById("tooltip");
document.querySelectorAll(".slot").forEach(el => {
    el.addEventListener("mouseenter", (e) => {
        const slotId = el.dataset.slot;
        const instId = state?.equipped[slotId];
        if (instId === null || !state?.instances[instId]) return;
        const item = state.instances[instId].def;
        document.getElementById("tooltip-name").textContent = item.name;
        const rarityEl = document.getElementById("tooltip-rarity");
        rarityEl.textContent = item.rarity;
        rarityEl.style.color = RARITY_COLORS[item.rarity] || "#9e9e9e";
        const statsEl = document.getElementById("tooltip-stats");
        statsEl.innerHTML = Object.entries(item.statBonuses || {})
            .map(([k, v]) => {
                const sign = v >= 0 ? "+" : "";
                const cls = v >= 0 ? "tooltip-stat" : "tooltip-stat negative";
                return '<div class="' + cls + '">' + sign + formatStat(k, v) + " " + (STAT_LABELS[k] || k) + "</div>";
            }).join("");
        tooltip.classList.add("visible");
        const rect = el.getBoundingClientRect();
        tooltip.style.left = (rect.right + 8) + "px";
        tooltip.style.top = rect.top + "px";
    });
    el.addEventListener("mouseleave", () => {
        tooltip.classList.remove("visible");
    });
});

// SSE live updates
const evtSource = new EventSource("/events");
evtSource.onmessage = (e) => {
    try {
        state = JSON.parse(e.data);
        updateUI();
    } catch {}
};
</script>
</body>
</html>`;
}
