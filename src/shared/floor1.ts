export type Floor1EnemyArchetype = 'rat' | 'slime';

export interface Floor1ObjectiveState {
  readonly requiredRats: number;
  readonly requiredSlimes: number;
  readonly requiredGold: number;
  readonly requiredJunk: number;
  readonly atomizationDeadlineMs: number;
  readonly safeRoomPos: { x: number; y: number };
  readonly staircasePos: { x: number; y: number };
  readonly markerRadiusPx: number;
  ratsKilled: number;
  slimesKilled: number;
  goldCollected: number;
  junkCollected: number;
  safeRoomDiscovered: boolean;
  staircaseUnlocked: boolean;
  staircaseDiscovered: boolean;
}

export interface Floor1RunSummary {
  outcome: 'failed_atomization' | 'cleared_floor';
  viewsEarned: number;
  fansEarned: number;
}

export interface Floor1ScenarioState {
  protagonistName: string;
  starterWeaponPool: readonly string[];
  starterChoices: string[];
  selectedWeaponId: string | null;
  selectedChoiceIndex: number | null;
  baseStatBonuses: {
    maxHp: number;
    moveSpeed: number;
    pickupRange: number;
  };
  enemyArchetypes: Map<number, Floor1EnemyArchetype>;
  objective: Floor1ObjectiveState;
  failReason: 'stair_atomization' | null;
  runSummary: Floor1RunSummary | null;
}
