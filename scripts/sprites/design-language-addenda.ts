import { floor2EnemyPack } from '../../src/shared/enemy-packs.js';

export interface DesignLanguageAddenda {
  readonly floor?: string;
  readonly theme?: string;
}

export const FLOOR_DESIGN_LANGUAGE: Readonly<Record<number, string>> = Object.freeze({
  2: 'Family Matters: An open underworld of feuding fantasy crime families fighting over a magical contraband Mother Lode. Its energy combines operatic mob hierarchy, territorial street-gang color, ritualized syndicate tradition, cartel excess, and anarchic open-world crime—filtered through dark fantasy and reality-TV satire. Every design should communicate allegiance, rank, vice, and improvised cave-industry without directly copying any real organization.',
});

export const FAMILY_DESIGN_LANGUAGE = Object.freeze({
  goblins:
    'The Snaggle Cartel mass-produces cheap “Snaggle Special” under Nana Snaggle Grubwix, a scrapyard matriarch who treats every grunt, junkslinger, and joyrider as expendable extended family. Bilious gang colors, patched leathers, crooked gold, battered motorcycles, and junk-built weapons make them a dark-fantasy street gang winning through speed and numbers.',
  llamas:
    'The Spit Syndicate distills Llambrusco for Don Paco “The Gob,” a vain vineyard don whose spitters and curb-stompers enforce etiquette while backlot capos manage distribution. Cream suits, stained ponchos, ornate bottles, bandoliers, and saliva-powered weapons combine hacienda cartel pageantry with absurd fantasy dignity.',
  pandas:
    'The Bamboo Triad ferments Bamboo Baijiu beneath Big Panda Wei, an immovable honcho whose bruisers protect the operation while snipers and red-envelope collectors enforce debts. Black, white, jade, and red designs combine ceremonial robes, heavy armor, bamboo contraband vessels, and severe syndicate geometry.',
  faeries:
    'The Glitterkin refine Faedust for Queen Mab Tarnish, a fallen court sovereign who rules blinkers, spark-casters, and drive-by shotcallers through glamour, addiction, and capricious favor. Tarnished crowns, magenta gang colors, luminous powder, razor wings, and corrupted court finery turn a faerie court into a predatory nightclub crew.',
  kobolds:
    'The Emberkin Clan burns Dragon’s Breath under King Skritt the Unburnt, a scarred fire prophet whose torchbearers, candle gunners, and dragon-capos serve as both gang soldiers and cult devotees. Rust-red leathers, scorched scales, ritual brands, censers, fireworks, and salvaged furnace armor create a zealously theatrical fire cartel.',
  myconids:
    'The Sporeholders culture Sporeshine beneath the Sovereign Cap, an ancient fungal kingpin connected biologically and spiritually to every adept, clubcap, and spore-capo. Violet clouds, velvet decay, fermentation vessels, respirators, and fruiting-body regalia evoke a narcotic monastery operating as a slow, collective syndicate.',
  toadkin:
    'The Croak Family produces Toad Sweat for Big Mama Bufo, a swamp matriarch whose bouncers hold the line, tonguers seize debtors, and consigliere translates her croaked decrees. Mottled greens, wet formalwear, gold swamp jewelry, apothecary jars, and tongue-based intimidation create a bayou crime dynasty built around bodily contraband.',
  gnomes:
    'The Cog Combine manufactures Cog-Grade pharmaceuticals for Overseer Fizzwick, an industrial racketeer who treats wheelmen, tinkers, and pinstripe artillerists as departments in a criminal corporation. Brass-and-blue uniforms, pinstripes, pill presses, turret briefcases, goggles, and immaculate machinery make organized crime look like a unionized dark-fantasy factory.',
  ratfolk:
    'The Gutter Guild cuts Gutter Dust beneath Plague-Boss Squick, a diseased undercity kingpin whose plague-rats flood the streets while snipers and underbosses protect the clean end of the business. Sickly browns, sewer heraldry, stolen finery, contaminated packets, rusted firearms, and plague-doctor fragments communicate filth weaponized as distribution infrastructure.',
  cactusfolk:
    'The Thornbloom Growers cultivate Sun-Grown product for Abuela Saguaro, a revered desert matriarch whose spinies guard the crop, needle gunners patrol its borders, and thornlords enforce family law. Desert green, sun-faded cartel finery, devotional charms, flowering contraband bundles, and weaponized spines create a proud agrarian dynasty with lethal hospitality.',
  batfolk:
    'The Nightwing Coven air-freights Echo for Countess Vesper, an aristocratic smuggling queen whose divers move product, sonic shooters defend the routes, and rave dons control the nightlife market. Deep purple, black velvet, aviation harnesses, glowing inhalant vials, cathedral jewelry, and club-culture accents make them gothic nobility operating an airborne narcotics ring.',
  crabfolk:
    'The Tidewrack Mob brine-cures Saltwater Taffy beneath Kingpin Molt, a heavily armored dock boss whose armored soldiers hold territory while claw gunners and shell-capos conduct waterfront shakedowns. Red-orange shells, sailor tattoos, gold chains, dockworker coats, candy wrappers, and barnacled armor evoke a fantasy port syndicate that wears its protection racket literally.',
  beetlefolk:
    'The Chitin Clan presses Scarab Caps for the Broodfather, a dynastic patriarch whose chargers form the street muscle, resin gunners control lanes, and glossy lieutenants display the clan’s wealth. Iridescent carapaces, scarab seals, lacquered armor, capsule bandoliers, resin weapons, and luxury carriage details create an ancient crime lineage obsessed with speed and inheritance.',
  molefolk:
    'The Deepdig Union sells uncut Motherlode under Foreman Grubbs, a pit boss who controls every tunnel through burrowers, gravel slingers, and subordinate foremen. Grey-brown workwear, union badges, headlamps, blasting tools, dust masks, and understated gold turn a mining crew into a subterranean labor racket that owns both product and route.',
  raccoons:
    'The Trash Panda Family dilutes stolen stock into Dumpster Fire for Boss Bandit Rocco, a charismatic heist planner whose thieves acquire ingredients while rocketeers and capos turn every raid into spectacle. Grey-black masks, scavenged streetwear, taped bottles, stolen jewelry, improvised explosives, and mismatched luxury goods create a chaotic burglary crew aspiring to criminal royalty.',
  geese:
    'The Honk Mob extracts the Honk Tax for Don Honkrado, the Godgoose, an untouchable protection boss whose enforcers pursue debtors, gatling ganders suppress resistance, and street marshals announce his authority. White feathers, orange accents, severe black formalwear, territorial ribbons, oversized weapons, and sacred-family portraiture make absurd waterfowl feel relentlessly imperial.',
  imps: 'The Brimstone Boys cook volatile Brimstone under Foreman Scorch, a hellish lab boss who sends chain brawlers to secure ingredients while flingers and capos defend the cooksite. Crimson gang marks, furnace leathers, respirators, infernal glassware, chains, burn scars, and unstable fire weapons combine demonic industry with a reckless clandestine laboratory.',
  snailfolk:
    'The Slowlane Syndicate ages Vintage Slime for the Gastropod Godfather, an ancient patient don whose slimers obstruct pursuit, artillery controls distance, and slick dons manage long-term debts. Olive shells, weathered formalwear, wax-sealed bottles, heirloom gold, velvet upholstery, and glossy slime trails create a ponderous old-world dynasty whose power comes from inevitability.',
});

const FLOOR_2_FAMILY_BY_SPRITE_NAME = new Map(
  floor2EnemyPack.archetypes.flatMap((archetype) =>
    archetype.familyId === undefined ? [] : [[archetype.id, archetype.familyId] as const],
  ),
);

/**
 * Boss/character-specific addenda appended to the family theme blurb when the
 * archetype name matches. Keeps boss-only visual traits (e.g. grandmother cues
 * for Abuela Saguaro) out of the family-wide blurb so they don't contaminate
 * other archetypes in the same family (e.g. cactusfolk-spiny).
 */
const ARCHETYPE_THEME_ADDENDA: Readonly<Partial<Record<string, string>>> = {
  'cactusfolk-boss':
    'Abuela Saguaro reads unmistakably as an elderly grandmother: a stooped, hunched-forward posture, deeply wrinkled and weathered flesh with age-lined ridges, small wire-rimmed spectacles, and a faded floral rebozo draped over one shoulder.',
};

function canonicalSpriteName(name: string): string {
  return name.replace(/-v\d+$/, '');
}

export function resolveDesignLanguageAddenda(
  name: string,
  floor: number,
  themeOverride?: string,
): DesignLanguageAddenda {
  const canonical = canonicalSpriteName(name);
  const floorAddendum = FLOOR_DESIGN_LANGUAGE[floor];
  const familyId = floor === 2 ? FLOOR_2_FAMILY_BY_SPRITE_NAME.get(canonical) : undefined;
  const familyTheme =
    familyId === undefined
      ? undefined
      : FAMILY_DESIGN_LANGUAGE[familyId as keyof typeof FAMILY_DESIGN_LANGUAGE];
  const archetypeExtra = familyTheme !== undefined ? ARCHETYPE_THEME_ADDENDA[canonical] : undefined;
  const authoredTheme = themeOverride?.trim();
  const themeAddendum =
    authoredTheme && authoredTheme.length > 0
      ? authoredTheme
      : familyTheme !== undefined && archetypeExtra !== undefined
        ? `${familyTheme} ${archetypeExtra}`
        : familyTheme;

  return {
    ...(floorAddendum === undefined ? {} : { floor: floorAddendum }),
    ...(themeAddendum === undefined ? {} : { theme: themeAddendum }),
  };
}
