/** Event contract for quest progression updates. */

export interface QuestCounterSetEvent {
  readonly type: 'quest.counter.set';
  readonly questId: string;
  readonly objectiveId: string;
  readonly value: number;
}

export interface QuestCounterAddEvent {
  readonly type: 'quest.counter.add';
  readonly questId: string;
  readonly objectiveId: string;
  readonly amount: number;
}

export interface QuestNpcTalkEvent {
  readonly type: 'quest.npc.talked';
  readonly npcId: string;
}

export type QuestEvent = QuestCounterSetEvent | QuestCounterAddEvent | QuestNpcTalkEvent;
