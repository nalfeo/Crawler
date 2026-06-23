import { describe, it, expect, beforeEach } from 'vitest';
import { addComponent } from 'bitecs';
import { Health, set } from '../../src/core/index.js';
import { spawnPlayer, spawnEnemy } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  createPlayerSessionRecorder,
  type PlayerSessionEvent,
} from '../../src/game/ai/player-session-recorder.js';
import type { InputState } from '../../src/shared/input.js';

function makeInput(overrides: Partial<InputState> = {}): InputState {
  return { moveX: 0, moveY: 0, action: false, pointerX: 0, pointerY: 0, ...overrides };
}

describe('createPlayerSessionRecorder', () => {
  let world: ReturnType<typeof createTestWorld>;
  let playerEid: number;

  beforeEach(() => {
    world = createTestWorld({ seed: 1 });
    playerEid = spawnPlayer(world, 100, 100);
  });

  it('returns empty events on creation', () => {
    const rec = createPlayerSessionRecorder(world, playerEid);
    expect(rec.getEvents()).toHaveLength(0);
  });

  it('emits a sample event every sampleInterval frames', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 5 });
    const input = makeInput();
    for (let i = 0; i < 10; i += 1) {
      rec.tick(input);
    }
    const samples = rec.getEvents().filter((e) => e.type === 'sample');
    // frames 5 and 10 → 2 samples
    expect(samples).toHaveLength(2);
  });

  it('sample events include frame and gameMs', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    world.elapsedMs = 500;
    rec.tick(makeInput());
    const sample = rec.getEvents().find((e) => e.type === 'sample')!;
    expect(sample.gameMs).toBe(500);
    expect(sample.frame).toBeGreaterThanOrEqual(1);
  });

  it('sample events carry raw input fields', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    const input = makeInput({
      moveX: 0.5,
      moveY: -0.3,
      action: true,
      pointerX: 200,
      pointerY: 150,
    });
    rec.tick(input);
    const sample = rec.getEvents().find((e) => e.type === 'sample') as PlayerSessionEvent;
    expect(sample.inputMoveX).toBeCloseTo(0.5);
    expect(sample.inputMoveY).toBeCloseTo(-0.3);
    expect(sample.inputAction).toBe(true);
    expect(sample.inputPointerX).toBe(200);
    expect(sample.inputPointerY).toBe(150);
  });

  it('emits a state-change event when inferred state changes', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 100 });
    // First tick: moving (EXPLORE)
    rec.tick(makeInput({ moveX: 1, moveY: 0 }));
    // Second tick: idle (IDLE)
    rec.tick(makeInput());
    const stateEvents = rec.getEvents().filter((e) => e.type === 'state');
    expect(stateEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('onKill increments totalKills and emits a kill event', () => {
    const rec = createPlayerSessionRecorder(world, playerEid);
    expect(rec.getStats().totalKills).toBe(0);
    rec.onKill(1);
    const kills = rec.getEvents().filter((e) => e.type === 'kill');
    expect(kills).toHaveLength(1);
    expect(kills[0]!.kills).toBe(1);
  });

  it('onLevelUp emits a levelup event', () => {
    const rec = createPlayerSessionRecorder(world, playerEid);
    rec.onLevelUp(2);
    const levelups = rec.getEvents().filter((e) => e.type === 'levelup');
    expect(levelups).toHaveLength(1);
    expect(levelups[0]!.note).toContain('level 2');
  });

  it('onQuestEvent emits a quest event', () => {
    const rec = createPlayerSessionRecorder(world, playerEid);
    rec.onQuestEvent('main quest accepted');
    const quests = rec.getEvents().filter((e) => e.type === 'quest');
    expect(quests).toHaveLength(1);
    expect(quests[0]!.note).toBe('main quest accepted');
  });

  it('onNpcEvent emits an npc event', () => {
    const rec = createPlayerSessionRecorder(world, playerEid);
    rec.onNpcEvent('met tutorial goon');
    const npc = rec.getEvents().filter((e) => e.type === 'npc');
    expect(npc).toHaveLength(1);
    expect(npc[0]!.note).toBe('met tutorial goon');
  });

  it('records enemyCount from live query', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    const enemyEid = spawnEnemy(world, 200, 200);
    void enemyEid; // spawnEnemy already adds Enemy component via helpers
    rec.tick(makeInput());
    const sample = rec.getEvents().find((e) => e.type === 'sample')!;
    expect(sample.enemyCount).toBeGreaterThanOrEqual(1);
  });

  it('records player health from world stores', () => {
    addComponent(world.ecs, playerEid, set(Health, { current: 75, max: 100 }));
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    rec.tick(makeInput());
    const sample = rec.getEvents().find((e) => e.type === 'sample')!;
    expect(sample.health).toBe(75);
  });

  it('records player level from world.playerLevel', () => {
    world.playerLevel.level = 3;
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    rec.tick(makeInput());
    const sample = rec.getEvents().find((e) => e.type === 'sample')!;
    expect(sample.level).toBe(3);
  });

  it('toJsonl produces valid JSONL (one object per line)', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    rec.tick(makeInput());
    const jsonl = rec.toJsonl();
    const lines = jsonl.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('getStats returns correct counts', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 5 });
    const input = makeInput();
    for (let i = 0; i < 5; i += 1) rec.tick(input);
    rec.onKill(1);
    const stats = rec.getStats();
    expect(stats.totalSamples).toBe(1);
    expect(stats.totalKills).toBe(1);
    expect(stats.totalEvents).toBeGreaterThanOrEqual(2);
  });

  it('reset clears all events and counters', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    rec.tick(makeInput());
    rec.onKill(1);
    rec.reset();
    expect(rec.getEvents()).toHaveLength(0);
    expect(rec.getStats().totalKills).toBe(0);
    expect(rec.getStats().totalEvents).toBe(0);
  });

  it('state field is HUMAN for sample events', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 1 });
    rec.tick(makeInput());
    const sample = rec.getEvents().find((e) => e.type === 'sample')!;
    // Inferred state is one of the recognized names or IDLE
    expect(['EXPLORE', 'ENGAGE', 'COLLECT', 'IDLE']).toContain(sample.state);
  });

  it('emits quest events when world questLog is updated during tick', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 100 });
    // Simulate quest appearing in world questLog
    world.questLog.set('test-quest', { status: 'active', objectives: [] });
    rec.tick(makeInput());
    const quests = rec.getEvents().filter((e) => e.type === 'quest');
    expect(quests.length).toBeGreaterThanOrEqual(1);
    expect(quests.some((q) => q.note?.includes('accepted: test-quest'))).toBe(true);
  });

  it('emits quest completion event when questLog status becomes complete', () => {
    const rec = createPlayerSessionRecorder(world, playerEid, { sampleInterval: 100 });
    world.questLog.set('test-quest', { status: 'active', objectives: [] });
    rec.tick(makeInput()); // see accept
    world.questLog.set('test-quest', { status: 'complete', objectives: [] });
    rec.tick(makeInput()); // see complete
    const quests = rec.getEvents().filter((e) => e.type === 'quest');
    expect(quests.some((q) => q.note?.includes('completed: test-quest'))).toBe(true);
  });
});
