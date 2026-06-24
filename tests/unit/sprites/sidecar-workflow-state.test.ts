/**
 * Pure unit tests for the sidecar workflow-state helpers.
 *
 * These pin the durability contract (key, ETag, (de)serialisation,
 * precondition checks) independently of Fastify and the Azure SDK.
 */

import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_STATE_KEY,
  computeStateEtag,
  etagPreconditionFails,
  parseWorkflowState,
  serializeWorkflowState,
} from '../../../scripts/sprites/sidecar/workflow-state.js';

describe('WORKFLOW_STATE_KEY', () => {
  it('is a single global blob under the workflow-state prefix', () => {
    // The prefix keeps it out of /api/runs (which only matches 3-part
    // <briefId>/<runId>/summary.json keys).
    expect(WORKFLOW_STATE_KEY).toBe('workflow-state/queue.json');
    expect(WORKFLOW_STATE_KEY.startsWith('workflow-state/')).toBe(true);
  });
});

describe('computeStateEtag', () => {
  it('is stable: identical bytes yield identical hashes', () => {
    const a = Buffer.from('{"items":[],"selectedId":null,"nextSeq":1}', 'utf8');
    const b = Buffer.from('{"items":[],"selectedId":null,"nextSeq":1}', 'utf8');
    expect(computeStateEtag(a)).toBe(computeStateEtag(b));
  });

  it('is a 64-char lowercase hex sha256 digest', () => {
    const etag = computeStateEtag(Buffer.from('hello', 'utf8'));
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    // Known sha256("hello") vector.
    expect(etag).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('changes when content changes, including key reordering', () => {
    const forward = serializeWorkflowState({ a: 1, b: 2 });
    const reversed = serializeWorkflowState({ b: 2, a: 1 });
    expect(computeStateEtag(forward)).not.toBe(computeStateEtag(reversed));
  });
});

describe('serializeWorkflowState / parseWorkflowState', () => {
  it('round-trips an arbitrary queue-shaped object', () => {
    const state = {
      items: [{ id: 'item-1', seq: 1, brief: 'Purple Potion', stage: 'candidates' }],
      selectedId: 'item-1',
      nextSeq: 2,
    };
    const bytes = serializeWorkflowState(state);
    expect(parseWorkflowState(bytes)).toEqual({ state });
  });

  it('normalises undefined to a valid null document', () => {
    const bytes = serializeWorkflowState(undefined);
    expect(bytes.toString('utf8')).toBe('null');
    expect(parseWorkflowState(bytes)).toEqual({ state: null });
  });

  it('returns { state: null } for malformed/truncated JSON instead of throwing', () => {
    expect(parseWorkflowState(Buffer.from('{"items":[', 'utf8'))).toEqual({ state: null });
    expect(parseWorkflowState(Buffer.from('', 'utf8'))).toEqual({ state: null });
  });
});

describe('etagPreconditionFails', () => {
  const current = 'abc123';

  it('allows an unconditional write when If-Match is absent or empty', () => {
    expect(etagPreconditionFails(undefined, current)).toBe(false);
    expect(etagPreconditionFails(null, current)).toBe(false);
    expect(etagPreconditionFails('', current)).toBe(false);
    expect(etagPreconditionFails(undefined, null)).toBe(false);
  });

  it('treats If-Match: * as "must already exist"', () => {
    expect(etagPreconditionFails('*', current)).toBe(false);
    expect(etagPreconditionFails('*', null)).toBe(true);
  });

  it('requires an exact match against the current ETag', () => {
    expect(etagPreconditionFails(current, current)).toBe(false);
    expect(etagPreconditionFails('stale', current)).toBe(true);
    expect(etagPreconditionFails(current, null)).toBe(true);
  });
});
