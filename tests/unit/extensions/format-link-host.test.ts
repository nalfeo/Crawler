import { describe, expect, it } from 'vitest';

// The worktree-server-status canvas extension is plain ESM loaded by the
// Copilot runtime (it imports `@github/copilot-sdk`, which is not a project
// dependency), so the host-formatting rule is factored into this pure sibling
// module. Importing that module keeps this regression test independent of the
// SDK. Types come from the colocated `format-link-host.d.mts`.
import { formatLinkHost } from '../../../.github/extensions/worktree-server-status/format-link-host.mjs';

describe('formatLinkHost', () => {
  // Regression guard for the bug where Vite binding the IPv6 loopback (`::1`)
  // rendered links as `http://[::1]:5199` instead of `http://localhost:5199`.
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['::1', 'IPv6 loopback'],
    ['localhost', 'literal localhost'],
    ['0.0.0.0', 'IPv4 wildcard'],
    ['::', 'IPv6 wildcard'],
    ['', 'empty string'],
  ])('collapses %s (%s) to localhost', (input) => {
    expect(formatLinkHost(input)).toBe('localhost');
  });

  it.each([[null], [undefined]])('collapses %s to localhost', (input) => {
    expect(formatLinkHost(input)).toBe('localhost');
  });

  it('normalizes case before matching loopback binds', () => {
    expect(formatLinkHost('LOCALHOST')).toBe('localhost');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(formatLinkHost('  ::1  ')).toBe('localhost');
  });

  it.each([['192.168.1.50'], ['10.0.0.5'], ['172.16.3.9']])(
    'passes real LAN IPv4 address %s through unchanged',
    (input) => {
      expect(formatLinkHost(input)).toBe(input);
    },
  );

  it.each([
    ['fe80::1', '[fe80::1]'],
    ['2001:db8::1', '[2001:db8::1]'],
  ])('brackets non-loopback IPv6 address %s', (input, expected) => {
    expect(formatLinkHost(input)).toBe(expected);
  });

  it('preserves original casing when bracketing IPv6', () => {
    expect(formatLinkHost('FE80::1')).toBe('[FE80::1]');
  });

  it('does not double-bracket an already-bracketed IPv6 address', () => {
    expect(formatLinkHost('[2001:db8::1]')).toBe('[2001:db8::1]');
  });
});
