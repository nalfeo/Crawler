import { createHash } from 'node:crypto';

export const ASSET_REQUEST_LABEL = 'asset-request';
export const ASSET_REQUEST_MARKER = 'asset-request:v1';

export interface AssetRequestPayload {
  readonly version: 1;
  readonly name: string;
  readonly briefSentence: string;
}

export interface ParsedAssetRequestIssue {
  readonly name: string;
  readonly briefSentence: string;
  readonly fingerprint: string;
}

export function parseAssetRequestIssueBody(body: string): ParsedAssetRequestIssue | null {
  if (typeof body !== 'string') return null;
  const startMarker = `<!-- ${ASSET_REQUEST_MARKER}`;
  const start = body.indexOf(startMarker);
  if (start !== -1) {
    const end = body.indexOf('-->', start + startMarker.length);
    if (end !== -1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.slice(start + startMarker.length, end).trim());
      } catch {
        parsed = null;
      }
      if (isAssetRequestPayload(parsed)) {
        return {
          name: parsed.name,
          briefSentence: parsed.briefSentence,
          fingerprint: fingerprintAssetRequest(parsed.name, parsed.briefSentence),
        };
      }
    }
  }
  // Fallback for issue-form rendered text ("### Name", "### Brief").
  const fallback = parseIssueFormBody(body);
  if (!fallback) return null;
  return {
    ...fallback,
    fingerprint: fingerprintAssetRequest(fallback.name, fallback.briefSentence),
  };
}

export function fingerprintAssetRequest(name: string, briefSentence: string): string {
  const normalized = `${name.trim().toLowerCase()}\n${briefSentence.trim().replace(/\s+/g, ' ')}`;
  return createHash('sha256').update(normalized).digest('hex');
}

function isAssetRequestPayload(value: unknown): value is AssetRequestPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.name !== 'string' || v.name.trim() === '') return false;
  if (!isSingleSentence(v.briefSentence)) return false;
  return true;
}

function isSingleSentence(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 8 || s.length > 240) return false;
  if (s.includes('\n')) return false;
  // Require terminal punctuation and at most one sentence terminal.
  if (!/[.!?]$/.test(s)) return false;
  return (s.match(/[.!?]/g) ?? []).length === 1;
}

function parseIssueFormBody(
  body: string,
): { readonly name: string; readonly briefSentence: string } | null {
  const nameMatch = body.match(/(?:^|\n)###\s+Name\s*\n+([^\n]+)/i);
  const briefMatch = body.match(/(?:^|\n)###\s+Brief\s*\n+([^\n]+)/i);
  if (!nameMatch || !briefMatch) return null;
  const name = nameMatch[1]!.trim();
  const briefSentence = briefMatch[1]!.trim();
  if (name === '' || !isSingleSentence(briefSentence)) return null;
  return { name, briefSentence };
}
