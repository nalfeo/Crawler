export interface BriefSelectorCandidate {
  readonly index: number;
  readonly description: string;
}

export interface SelectBriefRequest {
  readonly name: string;
  readonly briefSentence: string;
  readonly floor: number;
  readonly candidates: ReadonlyArray<BriefSelectorCandidate>;
}

export interface SelectBriefResult {
  readonly index: number;
  readonly rationale: string;
  readonly modelDeployment: string;
}

export interface BriefSelectorProvider {
  readonly modelDeployment: string;
  selectBrief(request: SelectBriefRequest): Promise<SelectBriefResult>;
}
