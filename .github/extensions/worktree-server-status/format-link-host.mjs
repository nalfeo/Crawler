/**
 * Render a discovered server's local bind address as the host of a clickable
 * link.
 *
 * All loopback and wildcard binds — `127.0.0.1`, `::1`, `localhost`, `0.0.0.0`,
 * `::`, and empty/unknown — collapse to `localhost` so links stay readable and
 * clickable even when Vite binds only the IPv6 loopback (`::1`). `localhost`
 * resolves to whichever family the server actually bound (Node's Happy Eyeballs
 * tries both), so the rendered link works regardless of IPv4 vs IPv6.
 *
 * Real LAN IPv4 addresses pass through unchanged. Genuine non-loopback IPv6
 * addresses are wrapped in brackets so they are valid inside a URL authority.
 * Values are trimmed before classification; an already-bracketed value is left
 * as-is (never double-bracketed).
 *
 * @param {string | null | undefined} localAddress Raw bind address as reported
 *   by discovery (e.g. `Get-NetTCPConnection`'s `LocalAddress`).
 * @returns {string} The host to use in a link (`localhost`, a bare IPv4, or a
 *   bracketed IPv6).
 */
export function formatLinkHost(localAddress) {
  const raw = (localAddress || '').trim();
  const normalized = raw.toLowerCase();
  if (
    !normalized ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost'
  ) {
    return 'localhost';
  }
  if (normalized.includes(':') && !normalized.startsWith('[')) {
    return `[${raw}]`;
  }
  return raw;
}
