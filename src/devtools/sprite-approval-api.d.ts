export interface SidecarRunListEntry {
  readonly briefId: string;
  readonly runId: string;
  readonly timestamp: string | null;
  readonly briefHash: string | null;
  readonly chosenIndex: number | null;
  readonly candidateCount: number | null;
  readonly hasJudge: boolean;
}
export interface ApproveResponse {
  readonly briefId: string;
  readonly spriteName: string;
  readonly assetPath: string;
  readonly approvedAt: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly source: string;
  } | null;
  readonly sensorScore: string;
  readonly judgeScore: string | null;
}
export declare function listSidecarRuns(fetcher?: typeof fetch): Promise<SidecarRunListEntry[]>;
export declare function fetchRunSummary(
  briefId: string,
  runId: string,
  fetcher?: typeof fetch,
): Promise<Record<string, unknown>>;
export declare function extractVariantIndices(summary: Record<string, unknown>): number[];
/**
 * Posts `variantIndex` to the sidecar approve endpoint and returns the created
 * manifest entry payload. Error text intentionally mirrors the previous lab
 * helper so existing call sites and tests keep the same contract.
 */
export declare function postApprove(
  briefId: string,
  runId: string,
  variantIndex: number,
  fetcher?: typeof fetch,
): Promise<ApproveResponse>;
//# sourceMappingURL=sprite-approval-api.d.ts.map
