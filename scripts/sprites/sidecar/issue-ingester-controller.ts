import { fingerprintAssetRequest, parseAssetRequestIssueBody } from '../asset-request.js';
import type { AssetQueue, IssueAssetRequest } from '../queue/types.js';
import type { RunStore } from '../store/types.js';
import type { AssetRequestIssueApi } from './asset-request-issue-api.js';

const INGEST_STATE_KEY = 'workflow-state/asset-request-ingest.json';

interface IngestState {
  readonly version: 1;
  readonly claims: Record<string, { issueNumber: number; fingerprint: string; claimedAt: string }>;
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

  const snapshot = (): IssueIngesterStatus => ({
    running,
    startedAt,
    stoppedAt,
    lastPollAt,
    lastError,
    enqueued,
    skippedDuplicate,
  });

  async function loadState(): Promise<IngestState> {
    if (!(await options.store.has(INGEST_STATE_KEY))) {
      return { version: 1, claims: {} };
    }
    try {
      const parsed = JSON.parse(
        (await options.store.get(INGEST_STATE_KEY)).toString('utf8'),
      ) as IngestState;
      if (!parsed || parsed.version !== 1 || typeof parsed.claims !== 'object') {
        return { version: 1, claims: {} };
      }
      return parsed;
    } catch {
      return { version: 1, claims: {} };
    }
  }

  async function saveState(state: IngestState): Promise<void> {
    await options.store.put(INGEST_STATE_KEY, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }

  async function pollOnce(): Promise<void> {
    lastPollAt = now().toISOString();
    const state = await loadState();
    const open = await options.issues.listOpenAssetRequestIssues();
    let dirty = false;
    for (const issue of open) {
      const payload = parseAssetRequestIssueBody(issue.body);
      if (!payload) continue;
      const fingerprint = fingerprintAssetRequest(payload.name, payload.briefSentence);
      const key = `${issue.number}:${fingerprint}`;
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
        fingerprint,
        claimedAt,
        requestedBy: options.requestedBy,
        requestedAt: claimedAt,
        priority: 'normal',
      };
      await options.queue.enqueue(message);
      state.claims[key] = { issueNumber: issue.number, fingerprint, claimedAt };
      enqueued += 1;
      dirty = true;
    }
    if (dirty) await saveState(state);
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
  };
}
