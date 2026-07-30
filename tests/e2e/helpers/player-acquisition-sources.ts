export const PLAYER_ACQUISITION_SOURCES = [
  'achievement-reward-claim',
  'quartermaster-purchase',
  'boss-chest',
  'floor-drop',
] as const;

export type PlayerAcquisitionSource = (typeof PLAYER_ACQUISITION_SOURCES)[number];
