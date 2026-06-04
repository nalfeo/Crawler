// Shared data: slot registry, stats, clamps

export const SLOT_REGISTRY = [
    { id: "head",      label: "Head",       bodyGroup: "head",  uiPosition: { x: 0.5, y: 0.02 } },
    { id: "face",      label: "Face",       bodyGroup: "head",  uiPosition: { x: 0.25, y: 0.08 } },
    { id: "neck",      label: "Neck",       bodyGroup: "torso", uiPosition: { x: 0.75, y: 0.08 } },
    { id: "shoulders", label: "Shoulders",  bodyGroup: "torso", uiPosition: { x: 0.5, y: 0.17 } },
    { id: "back",      label: "Back",       bodyGroup: "torso", uiPosition: { x: 0.12, y: 0.28 } },
    { id: "chest",     label: "Chest",      bodyGroup: "torso", uiPosition: { x: 0.5, y: 0.28 } },
    { id: "arms",      label: "Arms",       bodyGroup: "arms",  uiPosition: { x: 0.88, y: 0.28 } },
    { id: "belt",      label: "Belt",       bodyGroup: "torso", uiPosition: { x: 0.5, y: 0.40 } },
    { id: "wrists",    label: "Wrists",     bodyGroup: "arms",  uiPosition: { x: 0.88, y: 0.40 } },
    { id: "mainHand",  label: "Main Hand",  bodyGroup: "hands", uiPosition: { x: 0.08, y: 0.48 } },
    { id: "offHand",   label: "Off Hand",   bodyGroup: "hands", uiPosition: { x: 0.92, y: 0.48 } },
    { id: "gloves",    label: "Gloves",     bodyGroup: "hands", uiPosition: { x: 0.5, y: 0.52 } },
    { id: "ringLeft",  label: "Left Ring",  bodyGroup: "hands", uiPosition: { x: 0.20, y: 0.58 } },
    { id: "ringRight", label: "Right Ring", bodyGroup: "hands", uiPosition: { x: 0.80, y: 0.58 } },
    { id: "legs",      label: "Legs",       bodyGroup: "legs",  uiPosition: { x: 0.5, y: 0.70 } },
    { id: "feet",      label: "Feet",       bodyGroup: "legs",  uiPosition: { x: 0.5, y: 0.85 } },
];

export const PRIMARY_STATS = [
    "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma", "luck"
];

export const SECONDARY_STATS = [
    "armor", "damageBonus", "attackSpeed", "moveSpeed", "critChance",
    "critMultiplier", "dodgeChance", "hpRegen", "xpBonus", "cooldownReduction"
];

export const STAT_LABELS = {
    strength: "STR", dexterity: "DEX", constitution: "CON",
    intelligence: "INT", wisdom: "WIS", charisma: "CHA", luck: "LCK",
    armor: "Armor", damageBonus: "Dmg+", attackSpeed: "Atk Spd",
    moveSpeed: "Move Spd", critChance: "Crit %", critMultiplier: "Crit ×",
    dodgeChance: "Dodge %", hpRegen: "HP Regen", xpBonus: "XP+",
    cooldownReduction: "CDR",
};

export const DEFAULT_BASE_STATS = {
    strength: 1, dexterity: 1, constitution: 1,
    intelligence: 1, wisdom: 1, charisma: 1, luck: 1,
    armor: 0, damageBonus: 0, attackSpeed: 0, moveSpeed: 0,
    critChance: 0.05, critMultiplier: 1.5, dodgeChance: 0,
    hpRegen: 0, xpBonus: 0, cooldownReduction: 0,
};

export const STAT_CLAMPS = {
    strength: { min: 0 }, dexterity: { min: 0 }, constitution: { min: 0 },
    intelligence: { min: 0 }, wisdom: { min: 0 }, charisma: { min: 0 }, luck: { min: 0 },
    armor: { min: 0 }, attackSpeed: { min: 0.1 }, moveSpeed: { min: 0 },
    critChance: { min: 0, max: 1 }, critMultiplier: { min: 1 },
    dodgeChance: { min: 0, max: 0.75 }, hpRegen: { min: 0 },
    xpBonus: { min: 0 }, cooldownReduction: { min: 0, max: 0.80 },
};

export const RARITY_COLORS = {
    common: "#9e9e9e",
    uncommon: "#4caf50",
    rare: "#2196f3",
    epic: "#9c27b0",
    legendary: "#ff9800",
};

export const SLOT_ICONS = {
    head: "🪖", face: "🥽", neck: "📿", shoulders: "🛡️",
    back: "🧥", chest: "🦺", arms: "💪", belt: "🔗",
    wrists: "⌚", mainHand: "⚔️", offHand: "🛡️", gloves: "🧤",
    ringLeft: "💍", ringRight: "💍", legs: "🦵", feet: "👢",
};
