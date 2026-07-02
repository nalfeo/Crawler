import { fingerprintAssetRequest, parseAssetRequestIssueBody } from '../asset-request.js';
import type { AssetQueue, IssueAssetRequest } from '../queue/types.js';
import type { RunStore } from '../store/types.js';
import type { AssetRequestIssueApi } from './asset-request-issue-api.js';

export const INGEST_STATE_KEY = 'workflow-state/asset-request-ingest.json';

export async function isIssueRequestRejectedIngestState(
  store: RunStore,
  issueNumber: number,
  fingerprint: string,
): Promise<boolean> {
  const key = `${issueNumber}:${fingerprint}`;
  if (!(await store.has(INGEST_STATE_KEY))) return false;
  try {
    const parsed = JSON.parse((await store.get(INGEST_STATE_KEY)).toString('utf8')) as {
      rejected?: unknown;
    };
    const rejected =
      parsed && typeof parsed === 'object' && parsed.rejected && typeof parsed.rejected === 'object'
        ? parsed.rejected
        : null;
    if (!rejected) return false;
    return Object.prototype.hasOwnProperty.call(rejected, key);
  } catch {
    return false;
  }
}

interface IngestState {
  readonly version: 2;
  readonly claims: Record<
    string,
    {
      issueNumber: number;
      fingerprint: string;
      claimedAt: string;
      name: string;
      briefSentence: string;
    }
  >;
  readonly rejected: Record<
    string,
    {
      issueNumber: number;
      fingerprint: string;
      rejectedAt: string;
      reason: string | null;
      name: string;
      briefSentence: string;
    }
  >;
}

export interface IssueIngesterStatus {
  readonly running: boolean;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly enqueued: number;
  readonly skippedDuplicate: number;
}

export interface IssueIngesterController {
  start(): { readonly started: boolean; readonly status: IssueIngesterStatus };
  stop(): Promise<IssueIngesterStatus>;
  status(): IssueIngesterStatus;
  listRequests(
    state?: 'all' | 'pending' | 'claimed' | 'rejected',
  ): Promise<readonly AssetRequestManifestEntry[]>;
  rejectRequest(input: {
    issueNumber: number;
    fingerprint: string;
    reason?: string;
  }): Promise<AssetRequestManifestEntry | null>;
}

export interface AssetRequestManifestEntry {
  readonly key: string;
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly name: string;
  readonly briefSentence: string;
  readonly state: 'pending' | 'claimed' | 'rejected';
  readonly claimedAt: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly isOpen: boolean;
}

export interface CreateIssueIngesterOptions {
  readonly queue: AssetQueue;
  readonly store: RunStore;
  readonly issues: AssetRequestIssueApi;
  readonly requestedBy: string;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
}

export function createIssueIngesterController(
  options: CreateIssueIngesterOptions,
): IssueIngesterController {
  const pollMs = options.pollIntervalMs ?? 15_000;
  const now = options.now ?? (() => new Date());
  let running = false;
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  let lastPollAt: string | null = null;
  let lastError: string | null = null;
  let enqueued = 0;
  let skippedDuplicate = 0;
  let timer: NodeJS.Timeout | null = null;
  let stateLock: Promise<void> = Promise.resolve();

  async function withStateLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = stateLock;
    let release!: () => void;
    stateLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  const snapshot = (): IssueIngesterStatus => ({
    running,
    startedAt,
    stoppedAt,
    lastPollAt,
    lastError,
    enqueued,
    skippedDuplicate,
  });

  const claimKey = (issueNumber: number, fingerprint: string): string =>
    `${issueNumber}:${fingerprint}`;

  async function loadState(): Promise<IngestState> {
    if (!(await options.store.has(INGEST_STATE_KEY))) {
      return { version: 2, claims: {}, rejected: {} };
    }
    try {
      const parsed = JSON.parse((await options.store.get(INGEST_STATE_KEY)).toString('utf8')) as {
        version?: unknown;
        claims?: unknown;
        rejected?: unknown;
      };
      if (!parsed || typeof parsed !== 'object') {
        return { version: 2, claims: {}, rejected: {} };
      }
      const claimsRaw =
        typeof parsed.claims === 'object' && parsed.claims !== null ? parsed.claims : {};
      const rejectedRaw =
        typeof parsed.rejected === 'object' && parsed.rejected !== null ? parsed.rejected : {};
      const claims: IngestState['claims'] = {};
      for (const [key, value] of Object.entries(claimsRaw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        if (
          typeof row.issueNumber !== 'number' ||
          !Number.isInteger(row.issueNumber) ||
          row.issueNumber < 1 ||
          typeof row.fingerprint !== 'string' ||
          row.fingerprint === '' ||
          typeof row.claimedAt !== 'string'
        ) {
          continue;
        }
        claims[key] = {
          issueNumber: row.issueNumber,
          fingerprint: row.fingerprint,
          claimedAt: row.claimedAt,
          name: typeof row.name === 'string' ? row.name : '',
          briefSentence: typeof row.briefSentence === 'string' ? row.briefSentence : '',
        };
      }
      const rejected: IngestState['rejected'] = {};
      for (const [key, value] of Object.entries(rejectedRaw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        if (
          typeof row.issueNumber !== 'number' ||
          !Number.isInteger(row.issueNumber) ||
          row.issueNumber < 1 ||
          typeof row.fingerprint !== 'string' ||
          row.fingerprint === '' ||
          typeof row.rejectedAt !== 'string'
        ) {
          continue;
        }
        rejected[key] = {
          issueNumber: row.issueNumber,
          fingerprint: row.fingerprint,
          rejectedAt: row.rejectedAt,
          reason:
            typeof row.reason === 'string' && row.reason.trim() !== '' ? row.reason.trim() : null,
          name: typeof row.name === 'string' ? row.name : '',
          briefSentence: typeof row.briefSentence === 'string' ? row.briefSentence : '',
        };
      }
      return { version: 2, claims, rejected };
    } catch {
      return { version: 2, claims: {}, rejected: {} };
    }
  }

  async function saveState(state: IngestState): Promise<void> {
    await options.store.put(INGEST_STATE_KEY, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }

  async function pollOnce(): Promise<void> {
    lastPollAt = now().toISOString();
    const open = await options.issues.listOpenAssetRequestIssues();
    await withStateLock(async () => {
      const state = await loadState();
      let dirty = false;
      for (const issue of open) {
        const payload = parseAssetRequestIssueBody(issue.body);
        if (!payload) continue;
        const fingerprint = fingerprintAssetRequest(payload.name, payload.briefSentence);
        const key = claimKey(issue.number, fingerprint);
        if (state.rejected[key]) {
          skippedDuplicate += 1;
          continue;
        }
        if (state.claims[key]) {
          skippedDuplicate += 1;
          continue;
        }
        const claimedAt = now().toISOString();
        const message: IssueAssetRequest = {
          kind: 'issue-request',
          issueNumber: issue.number,
          name: payload.name,
          briefSentence: payload.briefSentence,
          ...(payload.type ? { type: payload.type } : {}),
          fingerprint,
          claimedAt,
          requestedBy: options.requestedBy,
          requestedAt: claimedAt,
          priority: 'normal',
        };
        await options.queue.enqueue(message);
        state.claims[key] = {
          issueNumber: issue.number,
          fingerprint,
          claimedAt,
          name: payload.name,
          briefSentence: payload.briefSentence,
        };
        enqueued += 1;
        dirty = true;
      }
      if (dirty) await saveState(state);
    });
  }

  function schedule(): void {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        await pollOnce();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        schedule();
      }
    }, pollMs);
  }

  return {
    start() {
      if (running) return { started: false, status: snapshot() };
      running = true;
      startedAt = now().toISOString();
      stoppedAt = null;
      void pollOnce()
        .catch((err) => {
          lastError = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          schedule();
        });
      return { started: true, status: snapshot() };
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      stoppedAt = now().toISOString();
      return snapshot();
    },
    status: snapshot,
    async listRequests(state = 'all') {
      return withStateLock(async () => {
        const ingestState = await loadState();
        const open = await options.issues.listOpenAssetRequestIssues();
        const out = new Map<string, AssetRequestManifestEntry>();
        for (const issue of open) {
          const payload = parseAssetRequestIssueBody(issue.body);
          if (!payload) continue;
          const key = claimKey(issue.number, payload.fingerprint);
          const claimed = ingestState.claims[key];
          const rejected = ingestState.rejected[key];
          out.set(key, {
            key,
            issueNumber: issue.number,
            fingerprint: payload.fingerprint,
            name: payload.name,
            briefSentence: payload.briefSentence,
            state: rejected ? 'rejected' : claimed ? 'claimed' : 'pending',
            claimedAt: claimed?.claimedAt ?? null,
            rejectedAt: rejected?.rejectedAt ?? null,
            rejectionReason: rejected?.reason ?? null,
            isOpen: true,
          });
        }
        if (state === 'all' || state === 'rejected') {
          for (const [key, rejected] of Object.entries(ingestState.rejected)) {
            if (out.has(key)) continue;
            out.set(key, {
              key,
              issueNumber: rejected.issueNumber,
              fingerprint: rejected.fingerprint,
              name: rejected.name,
              briefSentence: rejected.briefSentence,
              state: 'rejected',
              claimedAt: null,
              rejectedAt: rejected.rejectedAt,
              rejectionReason: rejected.reason,
              isOpen: false,
            });
          }
        }
        const values = [...out.values()].filter((entry) => {
          if (state === 'all') return true;
          return entry.state === state;
        });
        values.sort((a, b) => {
          const aTs = a.rejectedAt ?? a.claimedAt ?? '';
          const bTs = b.rejectedAt ?? b.claimedAt ?? '';
          if (aTs !== bTs) return aTs < bTs ? 1 : -1;
          return b.issueNumber - a.issueNumber;
        });
        return values;
      });
    },
    async rejectRequest(input) {
      return withStateLock(async () => {
        const issueNumber = input.issueNumber;
        const fingerprint = input.fingerprint;
        const reason =
          typeof input.reason === 'string' && input.reason.trim() !== ''
            ? input.reason.trim()
            : null;
        const ingestState = await loadState();
        const key = claimKey(issueNumber, fingerprint);

        let name = '';
        let briefSentence = '';
        const open = await options.issues.listOpenAssetRequestIssues();
        for (const issue of open) {
          if (issue.number !== issueNumber) continue;
          const payload = parseAssetRequestIssueBody(issue.body);
          if (!payload || payload.fingerprint !== fingerprint) continue;
          name = payload.name;
          briefSentence = payload.briefSentence;
          break;
        }
        const existingClaim = ingestState.claims[key];
        const existingRejected = ingestState.rejected[key];
        const resolvedName =
          name !== '' ? name : (existingRejected?.name ?? existingClaim?.name ?? '');
        const resolvedBriefSentence =
          briefSentence !== ''
            ? briefSentence
            : (existingRejected?.briefSentence ?? existingClaim?.briefSentence ?? '');
        ingestState.rejected[key] = {
          issueNumber,
          fingerprint,
          rejectedAt: now().toISOString(),
          reason,
          name: resolvedName,
          briefSentence: resolvedBriefSentence,
        };
        delete ingestState.claims[key];
        await saveState(ingestState);
        return {
          key,
          issueNumber,
          fingerprint,
          name: ingestState.rejected[key]!.name,
          briefSentence: ingestState.rejected[key]!.briefSentence,
          state: 'rejected',
          claimedAt: null,
          rejectedAt: ingestState.rejected[key]!.rejectedAt,
          rejectionReason: ingestState.rejected[key]!.reason,
          isOpen:
            open.find((issue) => {
              if (issue.number !== issueNumber) return false;
              const payload = parseAssetRequestIssueBody(issue.body);
              return payload?.fingerprint === fingerprint;
            }) !== undefined,
        };
      });
    },
  };
}
