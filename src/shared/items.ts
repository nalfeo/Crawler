/**
 * Item definitions — types, rarity, tag system, and the item catalog.
 *
 * Tags drive inventory tabs dynamically. KnownTag covers the canonical five;
 * CustomTag (branded string) lets AI-generated content invent new categories
 * at runtime ("Smelly Stuff", "Corpses", "Forbidden Snacks", etc.).
 */

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------

export enum ItemRarity {
  Common = 'Common',
  Uncommon = 'Uncommon',
  Rare = 'Rare',
  Epic = 'Epic',
  Legendary = 'Legendary',
}

/** Rarity → UI border/glow colour (hex). */
export const RARITY_COLORS: Record<ItemRarity, number> = {
  [ItemRarity.Common]: 0x9e9e9e,
  [ItemRarity.Uncommon]: 0x4caf50,
  [ItemRarity.Rare]: 0x2196f3,
  [ItemRarity.Epic]: 0xab47bc,
  [ItemRarity.Legendary]: 0xffc107,
};

// ---------------------------------------------------------------------------
// Tag system
// ---------------------------------------------------------------------------

export const KNOWN_TAGS = ['Materials', 'Weapons', 'Consumables', 'Key Items', 'Misc'] as const;
export type KnownTag = (typeof KNOWN_TAGS)[number];

/** Branded string for AI / surprise tags. */
export type CustomTag = string & { readonly __brand: 'CustomTag' };

export type ItemTag = KnownTag | CustomTag;

/** Create a custom tag (used by AI content pipeline or catalog). */
function customTag(label: string): CustomTag {
  return label as CustomTag;
}

export const _customTag = customTag;

const GENERATED_INVENTORY_TAG_ALIASES: Readonly<Record<string, KnownTag>> = Object.freeze({
  material: 'Materials',
  materials: 'Materials',
  weapon: 'Weapons',
  weapons: 'Weapons',
  consumable: 'Consumables',
  consumables: 'Consumables',
  'key item': 'Key Items',
  'key items': 'Key Items',
  'key-item': 'Key Items',
  'key-items': 'Key Items',
  misc: 'Misc',
  miscellaneous: 'Misc',
} as const satisfies Record<string, KnownTag>);

const GENERATED_GEAR_TAGS = new Set([
  'gear',
  'equipment',
  'armor',
  'armour',
  'accessory',
  'accessories',
]);

/**
 * Map generator-authored category tags onto the inventory taxonomy before
 * falling back to a branded custom tag.
 */
export function normalizeGeneratedInventoryTag(tag: string): ItemTag {
  const normalized = tag.trim().toLowerCase();
  const knownTag = GENERATED_INVENTORY_TAG_ALIASES[normalized];
  if (knownTag) return knownTag;
  if (GENERATED_GEAR_TAGS.has(normalized)) return customTag('Gear');
  return customTag(tag);
}

/** Type-guard: is this tag one of the canonical five? */
export function isKnownTag(tag: ItemTag): tag is KnownTag {
  return (KNOWN_TAGS as readonly string[]).includes(tag);
}

// ---------------------------------------------------------------------------
// Item definition
// ---------------------------------------------------------------------------

export interface ItemDef {
  /** Unique slug, e.g. "iron-ore" */
  id: string;
  /** Display name */
  name: string;
  description: string;
  /** At least one tag required. */
  tags: ItemTag[];
  rarity: ItemRarity;
  /** Use `Infinity` for unlimited stacking, `1` for non-stackable. */
  maxStack: number;
}

// ---------------------------------------------------------------------------
// Item catalog
// ---------------------------------------------------------------------------

const C = ItemRarity.Common;
const U = ItemRarity.Uncommon;
const R = ItemRarity.Rare;
const E = ItemRarity.Epic;
const L = ItemRarity.Legendary;

function mat(
  id: string,
  name: string,
  desc: string,
  rarity: ItemRarity,
  extraTags: ItemTag[] = [],
): ItemDef {
  return {
    id,
    name,
    description: desc,
    tags: ['Materials', ...extraTags],
    rarity,
    maxStack: 99,
  };
}

function wpn(
  id: string,
  name: string,
  desc: string,
  rarity: ItemRarity,
  extraTags: ItemTag[] = [],
): ItemDef {
  return {
    id,
    name,
    description: desc,
    tags: ['Weapons', ...extraTags],
    rarity,
    maxStack: 1,
  };
}

function con(
  id: string,
  name: string,
  desc: string,
  rarity: ItemRarity,
  extraTags: ItemTag[] = [],
): ItemDef {
  return {
    id,
    name,
    description: desc,
    tags: ['Consumables', ...extraTags],
    rarity,
    maxStack: 20,
  };
}

function key(
  id: string,
  name: string,
  desc: string,
  rarity: ItemRarity,
  extraTags: ItemTag[] = [],
): ItemDef {
  return {
    id,
    name,
    description: desc,
    tags: ['Key Items', ...extraTags],
    rarity,
    maxStack: 1,
  };
}

function misc(
  id: string,
  name: string,
  desc: string,
  rarity: ItemRarity,
  extraTags: ItemTag[] = [],
): ItemDef {
  return {
    id,
    name,
    description: desc,
    tags: ['Misc', ...extraTags],
    rarity,
    maxStack: 99,
  };
}

/**
 * Wearable gear (armor/accessories). Tagged only `Gear` (a custom tag) so it
 * groups under a dedicated inventory tab and never inflates the canonical
 * five tag counts. Non-stacking (`maxStack: 1`) like weapons. Each `gear`
 * item's slug is mirrored by an `EquipmentItemDef` in `equipmentDefs.ts`
 * (same id) so it round-trips bag → equip → unequip → bag.
 */
function gear(id: string, name: string, desc: string, rarity: ItemRarity): ItemDef {
  return {
    id,
    name,
    description: desc,
    tags: [customTag('Gear')],
    rarity,
    maxStack: 1,
  };
}

export const ITEM_CATALOG: readonly ItemDef[] = [
  // ── Materials (20) ──────────────────────────────────────────────────
  mat('iron-ore', 'Iron Ore', 'A chunk of crude iron. Smells like ambition.', C),
  mat('copper-ore', 'Copper Ore', 'Greenish and crumbly. Better than nothing.', C),
  mat('gold-nugget', 'Gold Nugget', 'Shiny enough to distract the audience.', U),
  mat('shadow-shard', 'Shadow Shard', 'A splinter of solidified darkness.', R),
  mat('void-crystal', 'Void Crystal', 'Hums with frequencies that hurt your teeth.', E),
  mat('star-fragment', 'Star Fragment', 'Fell from somewhere impossibly far away.', L),
  mat('raw-wood', 'Raw Wood', 'Splintery but sturdy.', C),
  mat('hardite-plank', 'Hardite Plank', 'Wood that refuses to burn.', U),
  mat('silk-thread', 'Silk Thread', 'Harvested from something with too many legs.', C),
  mat('dragon-scale', 'Dragon Scale', 'Iridescent and warm to the touch.', R),
  mat('bone-dust', 'Bone Dust', "Ground to a fine powder. Don't ask whose.", C, [
    customTag('Smelly Stuff'),
  ]),
  mat('ectoplasm-glob', 'Ectoplasm Glob', 'Gooey and faintly luminescent.', U, [
    customTag('Smelly Stuff'),
  ]),
  mat('mushroom-cap', 'Mushroom Cap', 'Spotted and suspicious.', C),
  mat('lava-glass', 'Lava Glass', 'Formed in volcanic vents. Fragile beauty.', U),
  mat('feathersteel', 'Feathersteel', 'Light as a feather, tough as nails.', R),
  mat('crystal-fiber', 'Crystal Fiber', 'Threads of pure resonance.', E),
  mat('living-stone', 'Living Stone', 'Pulses gently. Possibly breathing.', R),
  mat('aether-dust', 'Aether Dust', "Sparkles in dimensions you can't see.", E),
  mat('rusted-scrap', 'Rusted Scrap', 'Junk to most. Treasure to crafters.', C),
  mat('celestial-ingot', 'Celestial Ingot', "Forged in a star that hasn't been born yet.", L),

  // ── Weapons (20) ────────────────────────────────────────────────────
  wpn('throwing-knife', 'Throwing Knife', 'Balanced for a clean throw and a cleaner escape.', C),
  wpn('iron-sword', 'Sword', 'Serviceable. Boring. Gets the job done.', C),
  wpn('flame-dagger', 'Flame Dagger', 'The blade is warm. Always.', U),
  wpn('frost-bow', 'Bow', 'Reliable and easy to carry.', U),
  wpn('thunder-staff', 'Thunder Staff', 'Crackles ominously during weather reports.', R),
  wpn('void-scythe', 'Void Scythe', 'Cuts through matter and morale alike.', E),
  wpn('star-lance', 'Star Lance', 'Looks like a comet. Hits like one too.', L),
  wpn('bone-club', 'Baseball Bat', 'Heavy swing, simple results.', C, [customTag('Smelly Stuff')]),
  wpn('plasma-pistol', 'Pistol', 'A standard sidearm with no sci-fi extras.', R),
  wpn('fireball', 'Fireball', 'A compact sphere of bad decisions and splash damage.', U),
  wpn('laser', 'Laser', 'A continuous beam for contestants who hate subtlety.', R),
  wpn('punch', 'Punch', 'Your own two knuckles and a bad attitude.', C),
  wpn('landmine', 'Landmine', 'Set it, bait it, and let the room solve itself.', U),
  wpn('toxic-blowgun', 'Toxic Blowgun', "One puff and they're napping.", U),
  wpn('chain-whip', 'Chain Whip', 'Satisfying crack included.', R),
  wpn('obsidian-axe', 'Obsidian Axe', 'So sharp it cuts light.', R),
  wpn('gravity-hammer', 'Gravity Hammer', 'Weighs nothing until impact.', E),
  wpn('spectral-blade', 'Spectral Blade', 'Partially exists in another dimension.', E),
  wpn('director-mic', "Director's Microphone", 'Weaponized broadcasting. Very meta.', L),
  wpn('sling-of-shame', 'Sling of Shame', 'Rated #1 by audience vote.', U),
  wpn('anchor-mace', 'Anchor Mace', 'For when you need to make a point. Slowly.', R),
  wpn('twin-fangs', 'Twin Fangs', 'A pair of daggers that hum in harmony.', E),
  wpn('sponsor-sword', 'Sponsor Sword', 'Brought to you by GalactiCorp™.', L),

  // ── Consumables (20) ────────────────────────────────────────────────
  con('health-vial', 'Health Vial', 'Tastes like pennies and hope.', C),
  con('recharge-tonic', 'Recharge Tonic', 'Fizzy, electric, and rude to your cooldowns.', C),
  con('stim-shot', 'Stim Shot', 'Speed boost. Side effects undisclosed.', U),
  con('shield-scroll', 'Shield Scroll', 'Unfurl for instant protection.', U),
  con('smoke-bomb', 'Smoke Bomb', 'Vanish dramatically. Audience loves it.', U),
  con('rage-elixir', 'Rage Elixir', "Drink responsibly. (You won't.)", R),
  con('phoenix-tear', 'Phoenix Tear', 'One free do-over. Use wisely.', E),
  con('mystery-meat', 'Mystery Meat', 'Could be healing. Could be poison. Exciting!', C, [
    customTag('Smelly Stuff'),
  ]),
  con('broadcast-booster', 'Broadcast Booster', 'Temporarily maxes out your Broadcast Score.', R),
  con('floor-skip-pass', 'Floor Skip Pass', 'Executive override. Skip one floor.', L),
  con('antidote-pill', 'Antidote Pill', 'Cures most poisons. Most.', C),
  con('lucky-charm', 'Lucky Charm', 'Statistically dubious. Emotionally reassuring.', U),
  con('exp-candy', 'EXP Candy', 'Tastes like level-ups.', R),
  con('recall-stone', 'Recall Stone', 'Teleport to the last safe room.', R),
  con('time-capsule', 'Time Capsule', 'Freezes everything for 5 seconds.', E),
  con('audience-snack', 'Audience Snack', 'Throw to the crowd. They love it.', C),
  con('healing-fungus', 'Healing Fungus', 'Grows on dead things. Heals living ones.', U, [
    customTag('Smelly Stuff'),
  ]),
  con('berserker-brew', 'Berserker Brew', 'Double damage, half defense. YOLO.', R),
  con('sponsor-energy-drink', 'Sponsor Energy Drink', 'GalactiCorp™ keeps you going!', U),
  con('revival-kit', 'Revival Kit', 'Contains everything needed for a dramatic comeback.', L),

  // ── Key Items (20) ──────────────────────────────────────────────────
  key('floor-key-bronze', 'Bronze Floor Key', 'Opens the next floor. Probably.', C),
  key('floor-key-silver', 'Silver Floor Key', 'A slightly fancier door opener.', U),
  key('floor-key-gold', 'Gold Floor Key', 'Opens doors and impresses audiences.', R),
  key('floor-key-void', 'Void Floor Key', 'The lock dissolves when this approaches.', E),
  key('directors-pass', "Director's Pass", 'All-access backstage pass. Very exclusive.', L),
  key('map-fragment-a', 'Map Fragment A', 'Shows part of the next floor.', C),
  key('map-fragment-b', 'Map Fragment B', 'Another piece of the puzzle.', C),
  key('map-fragment-c', 'Map Fragment C', 'Three fragments, one truth.', U),
  key('sponsor-contract', 'Sponsor Contract', 'Read the fine print. Always.', R),
  key('audience-token', 'Audience Token', 'Grants one audience vote override.', U),
  key('season-badge', 'Season Badge', 'Proof you survived this far.', R),
  key('boss-trophy', 'Boss Trophy', 'Taken from something that wanted to keep it.', E),
  key('ancient-cipher', 'Ancient Cipher', 'The Gradient left this behind. Decrypt it.', L),
  key('green-room-key', 'Green Room Key', "Access to the safe room's VIP area.", U),
  key('producers-note', "Producer's Note", 'Hints at what the next floor holds.', R),
  key('broadcast-chip', 'Broadcast Chip', 'Contains a recording. Of what?', U),
  key('elevator-fuse', 'Elevator Fuse', "The elevator won't move without it.", R),
  key('vip-lanyard', 'VIP Lanyard', 'Looks important. Feels important.', U),
  key('classified-dossier', 'Classified Dossier', 'Eyes only. (Everyone reads it anyway.)', E),
  key(
    'glistening-rat-tail',
    'Glistening Rat Tail',
    'A still-warm, slime-slicked rat tail. The merchant requested it by name and asked that you "keep it moist." Do not think about why.',
    U,
    [customTag('Smelly Stuff')],
  ),

  // ── Misc (20) ───────────────────────────────────────────────────────
  misc('broken-circuit', 'Broken Circuit', 'Sparks occasionally. Mostly useless.', C),
  misc('alien-tooth', 'Alien Tooth', 'From a species with too many mouths.', U, [
    customTag('Smelly Stuff'),
  ]),
  misc('camera-lens', 'Camera Lens', 'Cracked. Still records.', C),
  misc('audience-rating-card', 'Audience Rating Card', '"7/10 — would watch die again."', U),
  misc('directors-cue-card', "Director's Cue Card", '"Look scared NOW."', R),
  misc('glitch-marble', 'Glitch Marble', 'Flickers between existing and not.', R),
  misc('contestant-badge', 'Contestant Badge', 'Your name is misspelled. Classic.', C),
  misc('foam-finger', 'Foam Finger', '#1 Fan (of watching you suffer).', C),
  misc('confetti-popper', 'Confetti Popper', 'For celebrating micro-victories.', C),
  misc('bootleg-dvd', 'Bootleg DVD', 'Previous season. Terrible quality.', U),
  misc('stress-ball', 'Stress Ball', 'Shaped like The Director. Very squeezable.', U),
  misc('autograph-book', 'Autograph Book', 'Collect signatures from the dead.', R, [
    customTag('TMI'),
  ]),
  misc('participation-trophy', 'Participation Trophy', '"You tried!" — The Director', C),
  misc('old-sock', 'Old Sock', 'Origin: unknowable. Smell: remarkable.', C, [
    customTag('Smelly Stuff'),
  ]),
  misc('shiny-button', 'Shiny Button', 'Do NOT press it. (You want to press it.)', R),
  misc('ghost-photo', 'Ghost Photo', "Shows someone who isn't there anymore.", E, [
    customTag('TMI'),
  ]),
  misc('laugh-track-tape', 'Laugh Track Tape', 'Plays canned laughter. Inappropriately.', U),
  misc('lucky-dice', 'Lucky Dice', 'Loaded. In your favor. Maybe.', R),
  misc('expired-coupon', 'Expired Coupon', '10% off at a store that no longer exists.', C),
  misc(
    'merchants-stained-charm',
    "Merchant's Magic Charm",
    'A faintly glowing pendant the merchant pressed into your hand. Worn around the neck, it grants +1 Charisma. Equippable.',
    U,
    [customTag('Gear')],
  ),
  // ── Catalog additions (index-stable append) ─────────────────────────
  mat(
    'bone-shard',
    'Bone Shard',
    'A jagged fragment pried from something that did not need all its bones.',
    C,
    [customTag('Smelly Stuff')],
  ),
  misc('pebble', 'Pebble', 'Smooth, ordinary, and somehow still worth carrying.', C),

  // ── Floor 1 harvestable materials ────────────────────────────────────
  mat(
    'crimson-mushroom',
    'Crimson Mushroom',
    'A plump red cap dusted with white spores. Warm to the touch.',
    C,
    [customTag('Flora')],
  ),
  mat(
    'azure-mushroom',
    'Azure Mushroom',
    'Deep blue gills that faintly glow in the dark. Handle with curiosity.',
    U,
    [customTag('Flora')],
  ),
  mat(
    'sunpetal-flower',
    'Sunpetal Flower',
    'Bright gold petals that somehow bloom without any sunlight.',
    C,
    [customTag('Flora')],
  ),
  mat(
    'moonbloom-flower',
    'Moonbloom',
    'Pale violet petals that unfurl only in darkness. Smells of cold stone.',
    U,
    [customTag('Flora')],
  ),
  mat(
    'frost-lichen',
    'Frost Lichen',
    'A silvery crust of ice-laced lichen clinging to damp walls.',
    C,
    [customTag('Flora')],
  ),
  mat(
    'shadow-lichen',
    'Shadow Lichen',
    'Dark grey patches that absorb light and whisper faintly when scraped.',
    U,
    [customTag('Flora')],
  ),

  // ── Wearable gear (equippable placeholders, one per body slot) ──────
  // Slug mirrors an EquipmentItemDef in equipmentDefs.ts (same id) so the
  // item round-trips bag → equip → unequip → bag. Tagged only 'Gear'.
  gear('iron-helm', 'Iron Helm', 'A dented pot with eyeholes. Surprisingly reassuring.', C),
  gear('iron-visor', 'Iron Visor', 'A slitted faceplate. You see less, you flinch less.', C),
  gear('steel-pauldrons', 'Steel Pauldrons', 'Broad shoulder plates. Makes doorways a gamble.', U),
  gear('iron-breastplate', 'Iron Breastplate', 'Heavy, honest protection for the vitals.', U),
  gear('travelers-cloak', "Traveler's Cloak", 'Frayed at the hem, quick on the feet.', U),
  gear('sturdy-belt', 'Sturdy Belt', 'Cinches the gut and steadies the nerves.', C),
  gear('iron-greaves', 'Iron Greaves', 'Shin plates that have met many shins.', U),
  gear('leather-boots', 'Leather Boots', 'Well-worn and quiet. Good for sprinting away.', C),
  gear('leather-gloves', 'Leather Gloves', 'Supple grip for a faster swing.', C),
  gear('bronze-vambrace', 'Bronze Vambrace', 'A left-arm guard, green with age.', C),
  gear('iron-armguard', 'Iron Armguard', 'A right-arm plate that adds bite to a blow.', C),
  gear('leather-bracer', 'Leather Bracer', 'Snug wrist wrap. Helps you slip a hit.', C),
  gear('beaded-bracelet', 'Beaded Bracelet', 'Lucky beads that rattle before a crit.', U),
  gear('band-of-fortune', 'Band of Fortune', 'A left-hand ring humming with dumb luck.', R),
  gear('signet-of-focus', 'Signet of Focus', 'A right-hand signet that sharpens the mind.', R),
];

// ---------------------------------------------------------------------------
// Catalog lookup helpers
// ---------------------------------------------------------------------------

const catalogById = new Map<string, ItemDef>();
const catalogByIndex = new Map<number, ItemDef>();
const catalogIndexById = new Map<string, number>();

for (let i = 0; i < ITEM_CATALOG.length; i++) {
  const item = ITEM_CATALOG[i]!;
  catalogById.set(item.id, item);
  catalogByIndex.set(i, item);
  catalogIndexById.set(item.id, i);
}

/** Look up an item definition by its unique `id` slug. */
export function getItemById(id: string): ItemDef | undefined {
  return catalogById.get(id);
}

/** Look up an item definition by its catalog index (matches droppedItem.itemIndex store). */
export function getItemByIndex(index: number): ItemDef | undefined {
  return catalogByIndex.get(index);
}

/** Get the catalog index for an item id. Returns -1 if not found. */
export function getItemIndex(id: string): number {
  return catalogIndexById.get(id) ?? -1;
}
