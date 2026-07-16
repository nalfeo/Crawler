import { createHash } from 'node:crypto';
import { SPRITE_TYPES } from './brief-schema.js';

export const ASSET_REQUEST_LABEL = 'asset-request';
export const ASSET_REQUEST_MARKER = 'asset-request:v1';

/**
 * Brief-text validation bounds.
 *
 * A brief is free-form prompt text that human authors write in the issue form
 * and that downstream brief synthesis consumes verbatim (`briefHint`). Authors
 * write rich, multi-sentence, multi-line paragraphs — so we deliberately do NOT
 * require a single sentence, a terminal punctuation mark, or the absence of
 * newlines. We only guard the two failure modes that actually matter:
 *
 *   - too short  → empty / garbage (reject when the collapsed text is under
 *                  `BRIEF_MIN_LENGTH`).
 *   - too long   → a runaway paste (an entire template, a novel, an accidental
 *                  dump). We bound this on two axes:
 *                    • `BRIEF_MAX_NORMALIZED_LENGTH` caps the whitespace-collapsed
 *                      text and is the effective ceiling for BOTH paths — it
 *                      bounds the downstream prompt. On the issue-form path the
 *                      brief is normalized (whitespace-collapsed) before its
 *                      length is checked, so this normalized cap — not the raw
 *                      cap — governs how much raw, whitespace-heavy input is
 *                      accepted there.
 *                    • `BRIEF_MAX_RAW_LENGTH` caps the raw trimmed input before
 *                      normalization. This is primarily a marker-payload guard:
 *                      the machine `asset-request:v1` marker is validated
 *                      verbatim (before any whitespace collapse), so the raw cap
 *                      bounds parse work on a pathological verbatim paste. It is
 *                      effectively subsumed by the normalized cap on the
 *                      issue-form path.
 *
 * The longest real brief observed across the open `asset-request` issues is
 * ~500 characters, so the normalized cap leaves ~4x headroom, comfortably
 * accepting multi-paragraph briefs while still rejecting pathological input.
 */
const BRIEF_MIN_LENGTH = 8;
const BRIEF_MAX_NORMALIZED_LENGTH = 2000;
const BRIEF_MAX_RAW_LENGTH = 4000;

export interface AssetRequestPayload {
  readonly version: 1;
  readonly name: string;
  readonly briefSentence: string;
  readonly type?: string;
  readonly floor?: number;
}

export interface ParsedAssetRequestIssue {
  readonly name: string;
  readonly briefSentence: string;
  readonly type?: string;
  readonly floor?: number;
  readonly fingerprint: string;
}

export function parseAssetRequestIssueBody(body: string): ParsedAssetRequestIssue | null {
  if (typeof body !== 'string') return null;
  // Normalize line endings up front so every heading/section regex below is
  // CRLF-safe (GitHub webhook and REST bodies may arrive with `\r\n`).
  const normalizedBody = body.replace(/\r\n?/g, '\n');
  const startMarker = `<!-- ${ASSET_REQUEST_MARKER}`;
  const start = normalizedBody.indexOf(startMarker);
  if (start !== -1) {
    const end = normalizedBody.indexOf('-->', start + startMarker.length);
    if (end !== -1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(normalizedBody.slice(start + startMarker.length, end).trim());
      } catch {
        parsed = null;
      }
      if (isAssetRequestPayload(parsed)) {
        // Machine-authored marker payload: preserve `briefSentence` verbatim so
        // the machine contract stays byte-stable for the downstream prompt. The
        // fingerprint collapses whitespace internally, so a marker payload and
        // the equivalent issue-form brief still hash identically.
        return {
          name: parsed.name,
          briefSentence: parsed.briefSentence,
          type: parsed.type && parsed.type.trim() !== '' ? parsed.type : undefined,
          floor: parsed.floor,
          fingerprint: fingerprintAssetRequest(parsed.name, parsed.briefSentence, parsed.floor),
        };
      }
    }
  }
  // Fallback for issue-form rendered text ("### Name", "### Brief", "### Type").
  const fallback = parseIssueFormBody(normalizedBody);
  if (!fallback) return null;
  return {
    ...fallback,
    fingerprint: fingerprintAssetRequest(fallback.name, fallback.briefSentence, fallback.floor),
  };
}

export function fingerprintAssetRequest(name: string, briefSentence: string, floor = 1): string {
  const normalized =
    `${name.trim().toLowerCase()}\n${briefSentence.trim().replace(/\s+/g, ' ')}` +
    (floor === 1 ? '' : `\nfloor:${floor}`);
  return createHash('sha256').update(normalized).digest('hex');
}

function isAssetRequestPayload(value: unknown): value is AssetRequestPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.name !== 'string' || v.name.trim() === '') return false;
  if (!isValidBriefText(v.briefSentence)) return false;
  // Reject payloads that still contain an unrendered GitHub Actions template
  // expression (`${{ … }}`). When a workflow fails to render the marker, these
  // leak literally into name/briefSentence; such a payload must fall back to the
  // (rendered) issue-form headings rather than enqueue a garbage request.
  if (containsUnrenderedTemplate(v.name) || containsUnrenderedTemplate(v.briefSentence)) {
    return false;
  }
  // Validate type if present: must be empty string, or a valid SPRITE_TYPES value
  if (typeof v.type === 'string' && v.type.trim() !== '') {
    if (!(SPRITE_TYPES as readonly string[]).includes(v.type.trim().toLowerCase())) {
      return false;
    }
  }
  if (
    v.floor !== undefined &&
    (typeof v.floor !== 'number' || !Number.isInteger(v.floor) || v.floor < 1 || v.floor > 20)
  ) {
    return false;
  }
  return true;
}

/**
 * Collapse a brief's surrounding and internal whitespace into a single clean
 * line. Mirrors the normalization `fingerprintAssetRequest` applies, so a
 * multi-line issue-form brief and its collapsed stored form share a fingerprint.
 */
function normalizeBriefText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * True when a value still holds an unrendered GitHub Actions template
 * expression (`${{ … }}`) — the tell-tale of a workflow that failed to
 * interpolate the marker payload.
 */
function containsUnrenderedTemplate(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${{');
}

/**
 * Accepts free-form brief prose (one or many sentences, single or multi-line).
 * See the `BRIEF_*` bounds above for the rationale behind the min/max guards.
 */
function isValidBriefText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  // Bound raw input before normalizing, so a pathological verbatim paste is
  // rejected up front. This bites the marker path (validated verbatim); the
  // issue-form path pre-normalizes its brief, so there the normalized cap below
  // is the effective ceiling.
  if (trimmed.length > BRIEF_MAX_RAW_LENGTH) return false;
  const normalized = normalizeBriefText(trimmed);
  return normalized.length >= BRIEF_MIN_LENGTH && normalized.length <= BRIEF_MAX_NORMALIZED_LENGTH;
}

function parseIssueFormBody(body: string): {
  readonly name: string;
  readonly briefSentence: string;
  readonly type?: string;
  readonly floor?: number;
} | null {
  const nameMatch = body.match(/(?:^|\n)###\s+Name\s*\n+([^\n]+)/i);
  // Capture the FULL Brief section — every line after the heading up to the next
  // "### " form heading (e.g. "### Type"), a trailing "<!-- asset-request:v1 -->"
  // marker comment, or the end of the body — then collapse it to a single clean
  // line. The separator matches only the heading's own line terminator
  // (`[^\S\n]*\n`), so an empty Brief section collapses to "" and is rejected
  // rather than bleeding into the next section. A line that itself begins with
  // "### " (or "<!--") inside the brief is treated as the next section boundary
  // (locked by unit test).
  const briefMatch = body.match(/(?:^|\n)###\s+Brief[^\S\n]*\n([\s\S]*?)(?=\n###\s|\n<!--|$)/i);
  if (!nameMatch || !briefMatch) return null;
  const name = nameMatch[1]!.trim();
  const briefSentence = normalizeBriefText(briefMatch[1]!);
  if (name === '' || !isValidBriefText(briefSentence)) return null;
  const typeMatch = body.match(/(?:^|\n)###\s+Type\s*\n+([^\n]+)/i);
  let type: string | undefined;
  if (typeMatch) {
    const candidate = typeMatch[1]!.trim().toLowerCase();
    // Validate type against SPRITE_TYPES; reject if invalid
    if (candidate && (SPRITE_TYPES as readonly string[]).includes(candidate)) {
      type = candidate;
    } else if (candidate !== '') {
      // Non-empty but invalid type is a parsing error
      return null;
    }
  }
  const floorMatch = body.match(/(?:^|\n)###\s+Floor(?:\s+\(optional\))?\s*\n+([^\n]+)/i);
  let floor: number | undefined;
  if (floorMatch && floorMatch[1]!.trim() !== '' && floorMatch[1]!.trim() !== '_No response_') {
    floor = Number(floorMatch[1]!.trim());
    if (!Number.isInteger(floor) || floor < 1 || floor > 20) return null;
  }
  return { name, briefSentence, type, floor };
}
