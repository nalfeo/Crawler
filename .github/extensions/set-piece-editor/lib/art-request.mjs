/**
 * Build `asset-request` issue payloads from the Set Piece Editor.
 *
 * The dresser is the person who knows a prop is missing — they are looking at
 * the hole in the room. Making them leave the editor, find the issue form, and
 * re-describe the room from memory is where "I need a bearskin rug" quietly
 * turns into no rug at all. This module lets the editor emit the SAME request
 * the issue form does, so the existing pipeline (generate → judge → approve →
 * check-in) picks it up with no new machinery.
 *
 * Two flows, one payload shape:
 *   - NEW ART      — "I need a bearskin rug."
 *   - VARIANT      — "I need this stove, but facing east." `basedOn` names the
 *                    shipped sprite, and the reference is written into the
 *                    brief PROSE (not a side field) because `briefSentence` is
 *                    what downstream brief synthesis consumes verbatim as
 *                    `briefHint`. A reference the generator never reads would
 *                    be a request that looks filed and silently does nothing.
 *
 * Emits the machine `asset-request:v1` marker rather than `### Name` headings.
 * `parseAssetRequestIssueBody` prefers the marker and treats it as byte-stable,
 * so a tool-authored request cannot be broken by issue-form re-rendering. The
 * human-readable headings are ALSO written, so the issue is legible on GitHub
 * and still parses if the marker is ever stripped.
 *
 * Contract source of truth: `scripts/sprites/asset-request.ts`.
 * `tests/art-request.test.mjs` parses those bounds out of the TS and asserts
 * this module agrees — this extension is standalone .mjs and cannot import it,
 * and the editor's other hand-copied contracts have drifted twice already.
 */

export const ASSET_REQUEST_MARKER = 'asset-request:v1';
export const ASSET_REQUEST_LABEL = 'asset-request';

/** Mirrors `SPRITE_TYPES` in `src/shared/sprite-types.ts`. */
export const SPRITE_TYPES = [
  'weapon',
  'equipment',
  'enemy',
  'item',
  'prop',
  'tile',
  'vfx',
  'character',
];

/** Mirrors `SIZE_VARIANTS` in `scripts/sprites/size-variants.ts`. */
export const SIZE_VARIANTS = ['default', 'wide', 'tall', 'large'];

/** Mirrors the brief bounds in `scripts/sprites/asset-request.ts`. */
export const BRIEF_MIN_LENGTH = 8;
export const BRIEF_MAX_NORMALIZED_LENGTH = 2000;
export const BRIEF_MAX_RAW_LENGTH = 4000;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Collapse whitespace the same way the parser's fingerprint does. */
function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Strip a generated sprite key back to the concept a human would say out loud:
 * `welcome-room-stove-v2-var-3` -> `welcome-room-stove`. Used to seed the name
 * field for a variant request so the dresser is not hand-editing suffixes.
 */
export function bareConceptOf(spriteId) {
  return String(spriteId || '')
    .replace(/^generated:/, '')
    .replace(/-var-\d+$/, '')
    .replace(/-v\d+$/, '')
    .trim();
}

/**
 * Suggest a name for a variant request: the base concept plus a slug of the
 * change ("east facing" -> `stove-east-facing`). Deliberately a SUGGESTION the
 * user can overwrite — an auto-name that silently collides with shipped art
 * would be worse than making them think for a second.
 */
export function suggestVariantName(spriteId, change) {
  const base = bareConceptOf(spriteId);
  const slug = normalize(change)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 3)
    .join('-');
  return slug ? `${base}-${slug}` : base;
}

/**
 * Validate + render an asset-request issue.
 *
 * Returns `{ ok: false, errors }` rather than throwing so the editor can show
 * every problem at once, the way the apply path already does.
 */
export function buildArtRequestIssue(input) {
  const errors = [];
  const name = String(input?.name ?? '').trim();
  const rawBrief = String(input?.brief ?? '');
  const basedOn = String(input?.basedOn ?? '').trim();
  const type = String(input?.type ?? '').trim();
  const sizeVariant = String(input?.sizeVariant ?? '').trim();
  const floorRaw = input?.floor;

  if (name === '') {
    errors.push('Name is required.');
  } else if (!NAME_RE.test(name)) {
    errors.push('Name must be lowercase kebab-case (e.g. `bearskin-rug`).');
  }

  if (rawBrief.trim().length > BRIEF_MAX_RAW_LENGTH) {
    errors.push(`Brief is too long (max ${BRIEF_MAX_RAW_LENGTH} characters).`);
  }

  // For a variant the reference must reach the generator, so it is prepended to
  // the brief text itself and therefore counts toward the length bounds.
  const briefSentence = basedOn
    ? normalize(
        `Based on the existing sprite \`${basedOn}\`: keep its palette, outline weight, scale and overall silhouette language, and change only what this request asks for. ${rawBrief}`,
      )
    : normalize(rawBrief);

  if (briefSentence.length < BRIEF_MIN_LENGTH) {
    errors.push(`Brief is too short (min ${BRIEF_MIN_LENGTH} characters).`);
  } else if (briefSentence.length > BRIEF_MAX_NORMALIZED_LENGTH) {
    errors.push(
      `Brief is too long (max ${BRIEF_MAX_NORMALIZED_LENGTH} characters once collapsed).`,
    );
  }

  if (type !== '' && !SPRITE_TYPES.includes(type)) {
    errors.push(`Type must be one of: ${SPRITE_TYPES.join(', ')}.`);
  }
  if (sizeVariant !== '' && !SIZE_VARIANTS.includes(sizeVariant)) {
    errors.push(`Size must be one of: ${SIZE_VARIANTS.join(', ')}.`);
  }

  let floor;
  if (floorRaw !== undefined && floorRaw !== null && String(floorRaw).trim() !== '') {
    floor = Number(floorRaw);
    if (!Number.isInteger(floor) || floor < 1 || floor > 20) {
      errors.push('Floor must be a whole number from 1 through 20.');
      floor = undefined;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const payload = { version: 1, name, briefSentence };
  if (type !== '') payload.type = type;
  if (floor !== undefined) payload.floor = floor;
  if (sizeVariant !== '') payload.sizeVariant = sizeVariant;

  // Headings first (what a human reads), marker last (what the pipeline reads).
  const lines = [
    '### Name',
    '',
    name,
    '',
    '### Brief',
    '',
    briefSentence,
    '',
    '### Type',
    '',
    type === '' ? '_No response_' : type,
    '',
    '### Floor',
    '',
    floor === undefined ? '_No response_' : String(floor),
    '',
    '### Size',
    '',
    sizeVariant === '' ? '_No response_' : sizeVariant,
    '',
  ];
  if (basedOn) {
    lines.push(
      '---',
      '',
      `Requested from the Set Piece Editor as a variant of \`${basedOn}\`.`,
      '',
    );
  } else {
    lines.push('---', '', 'Requested from the Set Piece Editor.', '');
  }
  lines.push(`<!-- ${ASSET_REQUEST_MARKER} ${JSON.stringify(payload)} -->`);

  return {
    ok: true,
    title: `Asset request: ${name}`,
    body: lines.join('\n'),
    labels: [ASSET_REQUEST_LABEL],
    payload,
  };
}
