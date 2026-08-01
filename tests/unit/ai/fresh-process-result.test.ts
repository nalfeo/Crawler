import { describe, expect, it } from 'vitest';
import { parseFreshProcessResult } from '../../../scripts/agent/perf/fresh-process-result.js';

const MARKER = 'RESULT=';

describe('parseFreshProcessResult', () => {
  it('parses the marked JSON result', () => {
    expect(
      parseFreshProcessResult<{ value: number }>(
        { status: 0, stdout: `noise\n${MARKER}{"value":42}\n`, stderr: '' },
        MARKER,
        'test child',
      ),
    ).toEqual({ value: 42 });
  });

  it('surfaces child startup and timeout errors', () => {
    expect(() =>
      parseFreshProcessResult(
        {
          error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' }),
          status: null,
          stdout: '',
          stderr: '',
        },
        MARKER,
        'test child',
      ),
    ).toThrow('test child failed to start: spawnSync timed out');
  });

  it('surfaces a nonzero child exit with stderr', () => {
    expect(() =>
      parseFreshProcessResult(
        { status: 2, stdout: '', stderr: 'worker failed' },
        MARKER,
        'test child',
      ),
    ).toThrow('test child exited with status 2: worker failed');
  });

  it('rejects missing result markers', () => {
    expect(() =>
      parseFreshProcessResult(
        { status: 0, stdout: '{"value":42}', stderr: '' },
        MARKER,
        'test child',
      ),
    ).toThrow('test child did not emit result marker "RESULT="');
  });

  it('rejects malformed marked JSON', () => {
    expect(() =>
      parseFreshProcessResult(
        { status: 0, stdout: `${MARKER}{bad`, stderr: '' },
        MARKER,
        'test child',
      ),
    ).toThrow('test child emitted malformed result JSON');
  });
});
