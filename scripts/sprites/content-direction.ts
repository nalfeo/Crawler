import type { DesignLanguageAddenda } from './design-language-addenda.js';

export const DEFAULT_FLOOR = 1;
export const MAX_FLOOR = 20;

export const CRAWLER_DESIGN_LANGUAGE = [
  'Crawler is a dark-fantasy dungeon rebuilt as deranged reality-show spectacle.',
  'Its design language combines expressive, offbeat RPG characters; retro-futurist salvage',
  'and corporate decay; and brutal improvised machinery, vehicles, armor, and contraptions.',
  '',
  'Build concepts from specific collisions between familiar things: panda mafia dons,',
  'goblin motorcycle gangs, plate-armored crabs wearing baseball caps, or ceremonial',
  'monsters carrying junk-built technology. Give each concept one instantly readable',
  'identity and one unforgettable contradiction: cute and threatening, mundane and',
  'monstrous, ceremonial and improvised, or bureaucratic and feral.',
  '',
  'The weirdness must feel authored. Avoid random ingredient soup, generic grim fantasy,',
  'and undirected gore. Preserve dark humor, a strong silhouette, and an obvious gameplay',
  'role. Deeper floors become stranger, more shocking, grotesque, frightening, and',
  'wonderful without becoming less readable.',
].join('\n');

function floorIntensityGuidance(floor: number): string {
  if (floor <= 1) {
    return 'Grounded baseline: use a recognizable dark-fantasy subject, practical salvage, and at most one strong absurd contradiction.';
  }
  if (floor <= 5) {
    return 'Introduce bolder subcultures, social roles, vehicles, improvised machinery, and coherent species/object collisions.';
  }
  if (floor <= 10) {
    return 'Add uncanny anatomy, stranger scale relationships, riskier hybrids, and contraptions with visibly questionable physics.';
  }
  if (floor <= 15) {
    return 'Become grotesque, frightening, and reality-bending while retaining authored purpose, dark humor, and a readable silhouette.';
  }
  return 'Reach the shocking/wonderful apex: impossible combinations, magnificent mutations, and production-design spectacle unique to Crawler rather than random visual noise.';
}

export function floorContextBlock(floor: number): string {
  return [
    `FLOOR: ${floor} of ${MAX_FLOOR}`,
    floorIntensityGuidance(floor),
    'Depth increases creative intensity, not detail density. Game-scale readability remains mandatory.',
  ].join('\n');
}

export function designLanguageAddendaBlock(addenda: DesignLanguageAddenda = {}): string {
  const hasAnyAddendum = addenda.floor !== undefined || addenda.theme !== undefined;
  return [
    ...(hasAnyAddendum
      ? [
          '## Design language priority',
          'These addenda refine, and may override, the general Crawler design language above. ' +
            'If any instruction here conflicts with another, resolve it in this priority order: ' +
            'theme design language > floor design language > general Crawler design language. ' +
            'When a conflict exists, ignore the lower-priority directive rather than blending it in. ' +
            'In particular, general Crawler dark-fantasy/dungeon-dressing motifs (armor, salvage, decay) ' +
            'must coordinate with — and never mask or bury — the higher-priority floor/theme-specific ' +
            'details; if a dressing element cannot coordinate without obscuring those details, omit it.',
          '',
        ]
      : []),
    ...(addenda.floor ? ['## Floor design language', addenda.floor] : []),
    ...(addenda.floor && addenda.theme ? [''] : []),
    ...(addenda.theme ? ['## Theme design language', addenda.theme] : []),
  ].join('\n');
}

export function contentDirectionBlock(floor: number, addenda: DesignLanguageAddenda = {}): string {
  const optionalAddenda = designLanguageAddendaBlock(addenda);
  return [
    CRAWLER_DESIGN_LANGUAGE,
    '',
    floorContextBlock(floor),
    ...(optionalAddenda ? ['', optionalAddenda] : []),
  ].join('\n');
}
