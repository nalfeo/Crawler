import { describe, expect, it } from 'vitest';
import {
  BTStatus,
  BehaviorTree,
  action,
  condition,
  inverter,
  repeat,
  selector,
  sequence,
  succeeder,
  type BTContext,
  type BTNode,
} from '../../src/game/ai/behavior-tree.js';
import { createTestWorld } from '../helpers/world-factory.js';

function makeContext(): BTContext {
  return {
    world: createTestWorld(),
    playerEid: 0,
    playerX: 0,
    playerY: 0,
    healthPercent: 1,
    blackboard: {},
  };
}

const ok = (name = 'ok'): BTNode => action(name, () => BTStatus.SUCCESS);
const fail = (name = 'fail'): BTNode => action(name, () => BTStatus.FAILURE);
const running = (name = 'run'): BTNode => action(name, () => BTStatus.RUNNING);

describe('behavior-tree framework', () => {
  const ctx = makeContext();

  describe('sequence (AND)', () => {
    it('succeeds when all children succeed', () => {
      expect(sequence('s', ok('a'), ok('b')).tick(ctx)).toBe(BTStatus.SUCCESS);
    });
    it('fails fast on the first failing child', () => {
      expect(sequence('s', ok(), fail(), ok()).tick(ctx)).toBe(BTStatus.FAILURE);
    });
    it('returns RUNNING when a child is still running', () => {
      expect(sequence('s', ok(), running()).tick(ctx)).toBe(BTStatus.RUNNING);
    });
  });

  describe('selector (OR)', () => {
    it('succeeds on the first succeeding child', () => {
      expect(selector('sel', fail(), ok('b')).tick(ctx)).toBe(BTStatus.SUCCESS);
    });
    it('fails when all children fail', () => {
      expect(selector('sel', fail(), fail()).tick(ctx)).toBe(BTStatus.FAILURE);
    });
    it('returns RUNNING when a child is still running', () => {
      expect(selector('sel', fail(), running()).tick(ctx)).toBe(BTStatus.RUNNING);
    });
  });

  describe('condition', () => {
    it('maps true to SUCCESS and false to FAILURE', () => {
      expect(condition('c', () => true).tick(ctx)).toBe(BTStatus.SUCCESS);
      expect(condition('c', () => false).tick(ctx)).toBe(BTStatus.FAILURE);
    });
  });

  describe('decorators', () => {
    it('inverter flips SUCCESS/FAILURE and passes RUNNING through', () => {
      expect(inverter('i', ok()).tick(ctx)).toBe(BTStatus.FAILURE);
      expect(inverter('i', fail()).tick(ctx)).toBe(BTStatus.SUCCESS);
      expect(inverter('i', running()).tick(ctx)).toBe(BTStatus.RUNNING);
    });

    it('succeeder always returns SUCCESS', () => {
      expect(succeeder('su', fail()).tick(ctx)).toBe(BTStatus.SUCCESS);
      expect(succeeder('su', ok()).tick(ctx)).toBe(BTStatus.SUCCESS);
    });

    it('repeat runs until the count is reached, then succeeds', () => {
      const node = repeat('r', ok(), 2);
      expect(node.tick(ctx)).toBe(BTStatus.RUNNING); // count 1
      expect(node.tick(ctx)).toBe(BTStatus.SUCCESS); // count 2 → done
    });

    it('repeat fails immediately if the child fails', () => {
      expect(repeat('r', fail(), 3).tick(ctx)).toBe(BTStatus.FAILURE);
    });

    it('repeat passes RUNNING through from the child', () => {
      expect(repeat('r', running(), 3).tick(ctx)).toBe(BTStatus.RUNNING);
    });

    it('repeat with a zero count short-circuits to SUCCESS', () => {
      expect(repeat('r', ok(), 0).tick(ctx)).toBe(BTStatus.SUCCESS);
    });
  });

  describe('BehaviorTree root + serialization', () => {
    it('ticks the root node', () => {
      const tree = new BehaviorTree(sequence('root', ok()));
      expect(tree.tick(ctx)).toBe(BTStatus.SUCCESS);
      expect(tree.getRoot().getName()).toBe('root');
    });

    it('serializes the tree structure recursively', () => {
      const tree = new BehaviorTree(
        selector(
          'root',
          condition('cond', () => true),
          inverter('inv', ok('leaf')),
        ),
      );
      const serialized = tree.serialize();
      expect(serialized).toMatchObject({ name: 'root', type: 'Selector' });
      expect(serialized.children).toHaveLength(2);
      expect(serialized.children[0]).toMatchObject({ name: 'cond', type: 'Condition' });
      const inverterNode = serialized.children[1];
      expect(inverterNode).toBeDefined();
      expect(inverterNode).toMatchObject({ name: 'inv', type: 'Inverter' });
      expect(inverterNode!.children[0]).toMatchObject({ name: 'leaf', type: 'Action' });
    });
  });
});
