import {
  VALID_SLOT_IDS,
  MIRROR_SLOT_PAIRS,
  MIRROR_SLOT_IDS,
  getMirrorSlot,
} from './equipment-slots.js';

const MIRROR_SLOT_METADATA_CHECK =
  MIRROR_SLOT_PAIRS.every(
    ([a, b]) =>
      VALID_SLOT_IDS.has(a) &&
      VALID_SLOT_IDS.has(b) &&
      getMirrorSlot(a) === b &&
      getMirrorSlot(b) === a,
  ) && MIRROR_SLOT_IDS.size === MIRROR_SLOT_PAIRS.length * 2;

if (!MIRROR_SLOT_METADATA_CHECK) {
  throw new Error(
    'mirror-slot-metadata: MIRROR_SLOT_PAIRS / getMirrorSlot consistency check failed',
  );
}
