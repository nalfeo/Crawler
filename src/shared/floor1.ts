export type Floor1EnemyArchetype = 'rat' | 'slime';

export interface Floor1ObjectiveState {
  readonly requiredRats: number;
  readonly requiredSlimes: number;
  readonly requiredGold: number;
  readonly requiredJunk: number;
  readonly deadlineMs: number;
  readonly staircaseSpawnCountdownMs: number;
  readonly safeRoomPos: { x: number; y: number };
  readonly staircasePos: { x: number; y: number };
  /** Position of the Welcome Office (spawn-room area) where the Tutorial Goon NPC stands. */
  readonly welcomeOfficePos: { x: number; y: number };
  readonly markerRadiusPx: number;
  /** True after the player talks to the Tutorial Goon and accepts the rat/slime quest. */
  questAccepted: boolean;
  /** True once the combined rat+slime kill target is met after quest acceptance. */
  questCompleted: boolean;
  ratsKilled: number;
  slimesKilled: number;
  goldCollected: number;
  junkCollected: number;
  safeRoomDiscovered: boolean;
  staircaseSpawnStartedMs: number | null;
  staircaseSpawnRemainingMs: number | null;
  staircaseSpawned: boolean;
  staircaseLocked: boolean;
  staircaseUnlocked: boolean;
  staircaseDiscovered: boolean;
  /** True once the player enters the boss room and the battle begins. */
  bossBattleStarted: boolean;
  staircaseBossEid: number | null;
  staircaseBossDefeated: boolean;
}

export interface Floor1RunSummary {
  outcome: 'failed_timeout' | 'cleared_floor';
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
  /** EID of the spawned Tutorial Goon NPC, or null if not yet spawned. */
  guideNpcEid: number | null;
  /** Door entity IDs guarding the boss room. */
  bossDoorEids: number[];
  objective: Floor1ObjectiveState;
  failReason: 'stair_timeout' | null;
  runSummary: Floor1RunSummary | null;
}
