/**
 * Production adapter for ADR 0073's phased theme-equipment set pipeline.
 * State remains the sole durable coordinator: a phase is saved only after all
 * of its item work and the one collection judgement complete successfully.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { approveVariant, type ManifestEntry } from './approve.js';
import { autoSelectVariants } from './auto-selection.js';
import { loadStyleGuide } from './build-prompt.js';
import { createDefaultQueueCommitDeps } from './queue-commit-runtime.js';
import {
  enableJudge,
  materializeAndLoadBrief,
  selectedBriefKey,
  selectedBriefRevision,
  THEME_EQUIPMENT_JUDGE_CONCURRENCY,
  THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS,
} from './theme-equipment-brief.js';
import { generateOne } from './generate-one.js';
import { loadRecordedReferencePngs } from './load-reference-pngs.js';
import {
  createBriefSelectorProvider,
  createImageProvider,
  createSynthProvider,
  createTextProvider,
  createVisionProvider,
} from './provider/factory.js';
import type { BriefSelectorProvider } from './provider/brief-selector-types.js';
import type { ImageProvider } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { VisionProvider } from './provider/vision-types.js';
import { loadRunSummary, rejudgeRun, repostprocessRun } from './rerun.js';
import { synthesizeBrief } from './synthesize-brief.js';
import { createRunStore } from './store/index.js';
import type { RunStore } from './store/types.js';
import {
  buildThemeEquipmentSetStateFromPlan,
  loadThemeEquipmentSetPlan,
  loadThemeEquipmentSetState,
  reviseRejectedThemeSetItem,
  saveThemeEquipmentSetState,
  advanceThemeSetPhase,
  isReviewPhase,
  THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
  type ThemeEquipmentArtifactEvidence,
  type ThemeEquipmentSetItem,
  type ThemeEquipmentSetState,
} from './theme-equipment-set.js';
import {
  judgeThemeEquipmentCollectionWithText,
  judgeThemeEquipmentCollectionWithVision,
  publishThemeEquipmentSet,
  RecoverableThemeSetItemError,
  runThemeEquipmentSetPhase,
  type ThemeEquipmentSetPhaseRunResult,
  type ThemeEquipmentTextJudgeProvider,
} from './theme-equipment-pipeline.js';
import type { CheckinAsset } from './checkin.js';
import type { QueueCommitDeps } from './queue-commit.js';

const STAGE_PREFIX = 'theme-equipment-stage-';

export class ThemeEquipmentRunnerError extends Error {
  override readonly name: string = 'ThemeEquipmentRunnerError';
}

/**
 * Thrown by `init`/`runPhase` when a phase pass CHECKPOINTED successfully
 * (every accepted item was persisted) but at least one item recoverably failed
 * or the collection judge threw. Carries the persisted state and per-item
 * failure detail so the CLI can surface a machine-readable status and a
 * driver-facing "re-run to regenerate only the failures" message. This is a
 * partial success — the accepted work is safe on disk — NOT a fatal.
 */
export class ThemeEquipmentSetPhasePartialError extends ThemeEquipmentRunnerError {
  override readonly name = 'ThemeEquipmentSetPhasePartialError';
  constructor(
    message: string,
    readonly state: ThemeEquipmentSetState,
    readonly succeededItemIds: readonly string[],
    readonly itemFailures: ThemeEquipmentSetPhaseRunResult['itemFailures'],
    readonly collectionJudgeError: string | null,
  ) {
    super(message);
  }
}

export interface ThemeEquipmentRunnerDeps {
  readonly repoRoot: string;
  readonly store: RunStore;
  readonly now: () => Date;
  readonly env: NodeJS.ProcessEnv;
  readonly synthProvider: ReturnType<typeof createSynthProvider> | null;
  readonly briefSelectorProvider: BriefSelectorProvider | null;
  readonly imageProvider: ImageProvider | null;
  readonly textProvider: TextProvider | null;
  readonly visionProvider: VisionProvider | null;
  readonly queueCommitDeps: QueueCommitDeps;
  readonly makeStageRoot?: () => string;
  readonly removeStageRoot?: (root: string) => void;
  /** Test seam; production stages every approved run through approveVariant. */
  readonly prepareApprovedAssets?: (
    state: ThemeEquipmentSetState,
    stageRoot: string,
  ) => Promise<CheckinAsset[]>;
  /** Test seam; production performs the one queue-backed atomic publish. */
  readonly publishSet?: typeof publishThemeEquipmentSet;
}

/**
 * Build the driver-facing message for a partial phase pass: what was
 * checkpointed, what failed and why, and the workflow command to re-run so
 * only up-reviewed/frozen items are skipped (every other item regenerates).
 */
function formatPartialMessage(setId: string, result: ThemeEquipmentSetPhaseRunResult): string {
  const parts: string[] = [];
  if (result.succeededItemIds.length > 0) {
    parts.push(
      `Checkpointed ${result.succeededItemIds.length} item(s): ${result.succeededItemIds.join(', ')}.`,
    );
  }
  if (result.itemFailures.length > 0) {
    const failures = result.itemFailures
      .map((failure) => `${failure.itemId} (${failure.message})`)
      .join('; ');
    parts.push(`Failed ${result.itemFailures.length} item(s): ${failures}.`);
  }
  if (result.collectionJudgeError) {
    parts.push(`Collection judge did not run: ${result.collectionJudgeError}.`);
  }
  parts.push(
    `Re-run: gh workflow run theme-equipment.yml -f action=run-phase -f set_id=${setId} ` +
      `(up-reviewed/frozen items are skipped; every other item regenerates).`,
  );
  return parts.join(' ');
}

/**
 * Build the real CLI/workflow dependencies. Kept separate from the runner so
 * tests can supply an in-memory RunStore and deterministic provider doubles.
 */
export function createThemeEquipmentRunnerDeps(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  mode: 'full' | 'state-only' = 'full',
): ThemeEquipmentRunnerDeps {
  const needsProviders = mode === 'full';
  return {
    repoRoot,
    store: createRunStore({ repoRoot, env }),
    now,
    env,
    synthProvider: needsProviders ? createSynthProvider({ env }) : null,
    briefSelectorProvider: needsProviders ? createBriefSelectorProvider({ env }) : null,
    imageProvider: needsProviders ? createImageProvider({ env }) : null,
    textProvider: needsProviders ? createTextProvider({ env }) : null,
    visionProvider: needsProviders ? createVisionProvider({ env }) : null,
    queueCommitDeps: createDefaultQueueCommitDeps(repoRoot, env),
  };
}

/**
 * The configured vision deployment is also used for text-only collection
 * reviews. This is intentionally not a TextProvider adapter: TextProvider
 * only expands variations and cannot evaluate a strict score/rationale shape.
 */
export function createVisionTextJudgeProvider(
  provider: VisionProvider,
): ThemeEquipmentTextJudgeProvider {
  return {
    modelDeployment: provider.modelDeployment,
    async complete(request) {
      const response = await provider.evaluate({
        systemInstructions: request.systemInstructions,
        userPrompt: request.userPrompt,
        images: [],
        temperature: request.temperature,
      });
      return { json: response.json, modelDeployment: response.modelDeployment };
    },
  };
}

export class ThemeEquipmentRunner {
  constructor(private readonly deps: ThemeEquipmentRunnerDeps) {}

  async init(planPath: string): Promise<ThemeEquipmentSetState> {
    const absolutePlanPath = path.resolve(this.deps.repoRoot, planPath);
    const planId = path.basename(absolutePlanPath, path.extname(absolutePlanPath));
    const plan = loadThemeEquipmentSetPlan(planId, {
      projectRoot: this.deps.repoRoot,
      planPath: absolutePlanPath,
    });
    const existing = await loadThemeEquipmentSetState(this.deps.store, plan.id);
    if (existing) {
      throw new ThemeEquipmentRunnerError(
        `Theme set "${plan.id}" already exists; use run-phase or advance instead of init.`,
      );
    }

    const state = buildThemeEquipmentSetStateFromPlan(plan, {
      updatedAt: this.deps.now().toISOString(),
    });
    const runResult = await runThemeEquipmentSetPhase(
      state,
      async (item) => this.rosterArtifacts(state, item),
      async (collection) => this.judgeTextCollection(collection, 'roster'),
    );
    // `init` always creates the doc (expectedRevision:null), so ALWAYS persist
    // the checkpoint — even a partial/fatal pass must not vanish.
    const persisted = await saveThemeEquipmentSetState(this.deps.store, runResult.state, {
      expectedRevision: null,
      now: this.deps.now,
    });
    return this.finishPhaseRun(plan.id, persisted, runResult);
  }

  async runPhase(setId: string): Promise<ThemeEquipmentSetState> {
    const loaded = await this.requireState(setId);
    if (!isReviewPhase(loaded.phase)) {
      throw new ThemeEquipmentRunnerError(
        `Theme set "${setId}" is complete and has no runnable phase.`,
      );
    }
    const expectedRevision = loaded.stateRevision;
    const runResult = await runThemeEquipmentSetPhase(
      loaded,
      (item, state) => this.executeItem(state, item),
      (state) => this.judgePhaseCollection(state),
      // Lazy per-item revision: revise a down-reviewed item immediately before
      // its own execution so a fatal error on item N never clears the artifacts
      // or bumps the revision of items N+1…M that were never attempted.
      (state, itemId) => {
        if (!isReviewPhase(state.phase)) return null;
        const item = state.items.find((c) => c.id === itemId);
        if (
          !item ||
          item.phases[state.phase].review.verdict !== 'down' ||
          item.frozenPhases.includes(state.phase)
        ) {
          return null;
        }
        return reviseRejectedThemeSetItem(state, itemId);
      },
    );
    // Persist only if something actually changed since we loaded (lazy
    // per-item revisions bump the revision, so any real work — or a failure
    // marker — makes this true). A truly no-op pass avoids a needless
    // same-revision write that would only churn the store.
    const mutated = runResult.state.stateRevision !== expectedRevision;
    const persisted = mutated
      ? await saveThemeEquipmentSetState(this.deps.store, runResult.state, {
          expectedRevision,
          now: this.deps.now,
        })
      : loaded;
    return this.finishPhaseRun(setId, persisted, runResult);
  }

  /**
   * Shared tail for `init`/`runPhase`: given the persisted checkpoint and the
   * graceful-run result, either (a) rethrow the original fatal error verbatim
   * (checkpoint already saved), (b) throw a `ThemeEquipmentSetPhasePartialError`
   * when the accepted work was saved but some items failed or the judge threw,
   * or (c) return the clean persisted state.
   */
  private finishPhaseRun(
    setId: string,
    persisted: ThemeEquipmentSetState,
    runResult: ThemeEquipmentSetPhaseRunResult,
  ): ThemeEquipmentSetState {
    if (runResult.fatalError) {
      // Checkpoint is saved; surface the ORIGINAL error unchanged so callers can
      // still distinguish e.g. a provider error from a pipeline error.
      throw runResult.fatalError.error;
    }
    if (runResult.itemFailures.length > 0 || runResult.collectionJudgeError) {
      throw new ThemeEquipmentSetPhasePartialError(
        formatPartialMessage(setId, runResult),
        persisted,
        runResult.succeededItemIds,
        runResult.itemFailures,
        runResult.collectionJudgeError,
      );
    }
    return persisted;
  }

  async advance(setId: string): Promise<ThemeEquipmentSetState> {
    const loaded = await this.requireState(setId);
    const mutation = advanceThemeSetPhase(loaded);
    if (!mutation.ok) {
      throw new ThemeEquipmentRunnerError(
        `Cannot advance theme set "${setId}": ${JSON.stringify(mutation.reasons)}`,
      );
    }
    return saveThemeEquipmentSetState(this.deps.store, mutation.state, {
      expectedRevision: loaded.stateRevision,
      now: this.deps.now,
    });
  }

  async status(setId: string): Promise<ThemeEquipmentSetState> {
    return this.requireState(setId);
  }

  async publish(setId: string): Promise<ThemeEquipmentSetState> {
    const loaded = await this.requireState(setId);
    if (loaded.phase !== 'complete' || loaded.publication.status !== 'held') {
      throw new ThemeEquipmentRunnerError(
        `Theme set "${setId}" may publish only when complete and held (currently ${loaded.phase}/${loaded.publication.status}).`,
      );
    }
    const expectedRevision = loaded.stateRevision;
    const stageRoot = this.makeStageRoot();
    try {
      const assets = this.deps.prepareApprovedAssets
        ? await this.deps.prepareApprovedAssets(loaded, stageRoot)
        : await this.stageApprovedAssets(loaded, stageRoot);
      const publish = this.deps.publishSet ?? publishThemeEquipmentSet;
      const published = await publish(loaded, {
        repoRoot: this.deps.repoRoot,
        sourceRoot: stageRoot,
        assets,
        deps: this.deps.queueCommitDeps,
        message: `feat(assets): publish theme equipment set ${loaded.id}`,
        now: this.deps.now,
      });
      return saveThemeEquipmentSetState(this.deps.store, published.state, {
        expectedRevision,
        now: this.deps.now,
      });
    } finally {
      this.removeStageRoot(stageRoot);
    }
  }

  private async executeItem(
    state: ThemeEquipmentSetState,
    item: ThemeEquipmentSetItem,
  ): Promise<{
    artifacts: readonly ThemeEquipmentArtifactEvidence[];
    evidence: readonly ThemeEquipmentArtifactEvidence[];
  }> {
    switch (state.phase) {
      case 'roster':
        return this.rosterArtifacts(state, item);
      case 'briefs':
        return this.synthesizeBriefArtifacts(state, item);
      case 'sprite-sheets':
        return this.generateSheetArtifacts(state, item);
      case 'variant-approval':
        return this.approveVariantArtifacts(state, item);
    }
    throw new ThemeEquipmentRunnerError(`Unsupported theme set phase "${state.phase}".`);
  }

  private rosterArtifacts(
    state: ThemeEquipmentSetState,
    item: ThemeEquipmentSetItem,
  ): {
    artifacts: readonly ThemeEquipmentArtifactEvidence[];
    evidence: readonly ThemeEquipmentArtifactEvidence[];
  } {
    const concept =
      item.kind === 'weapon'
        ? `${item.displayName} (${item.weaponType} weapon)`
        : `${item.displayName} (${item.slots.join(', ')} equipment)`;
    const base = `${item.id}-roster-r${item.revision}`;
    return {
      artifacts: [
        {
          id: `${base}-concept`,
          kind: 'roster-concept',
          uri: `theme-sets/${state.id}/roster/${item.id}`,
          summary: `${concept}. Theme: ${state.themeDesignLanguage}`,
          provenance: 'authored-plan',
        },
      ],
      evidence: [
        {
          id: `${base}-theme`,
          kind: 'theme-context',
          uri: `theme-sets/${state.id}/roster/${item.id}/theme`,
          summary: state.themeDesignLanguage,
          provenance: 'authored-plan',
        },
      ],
    };
  }

  private async synthesizeBriefArtifacts(
    state: ThemeEquipmentSetState,
    item: ThemeEquipmentSetItem,
  ): Promise<{
    artifacts: readonly ThemeEquipmentArtifactEvidence[];
    evidence: readonly ThemeEquipmentArtifactEvidence[];
  }> {
    const selector = this.deps.briefSelectorProvider;
    if (!selector) {
      throw new ThemeEquipmentRunnerError(
        'Theme-equipment brief synthesis requires AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT.',
      );
    }
    const theme = {
      setId: state.id,
      displayName: state.displayName,
      designLanguage: state.themeDesignLanguage,
    };
    const synthesis = await synthesizeBrief({
      name: `${state.id}-${item.id}`,
      briefHint: `${item.displayName}. Theme context: ${JSON.stringify(theme)}`,
      theme,
      type: item.kind === 'weapon' ? 'weapon' : 'equipment',
      candidates: 3,
      provider: this.requireSynth(),
      repoRoot: this.deps.repoRoot,
      outputRoot: path.join(this.deps.repoRoot, 'generated', 'theme-equipment-brief-candidates'),
      env: this.deps.env,
    });
    const selected = await selector.selectBrief({
      name: item.id,
      briefSentence: `${item.displayName}. ${state.themeDesignLanguage}`,
      floor: 1,
      candidates: synthesis.written.map((candidate, index) => ({
        index,
        description: candidate.description,
      })),
    });
    const candidate = synthesis.written[selected.index];
    if (!candidate) {
      throw new ThemeEquipmentRunnerError(
        `Brief selector returned index ${selected.index} outside ${synthesis.written.length} candidates for "${item.id}".`,
      );
    }
    const enabledYaml = enableJudge(readFileSync(candidate.yamlPath, 'utf8'));
    const briefKey = selectedBriefKey(state, item);
    await this.deps.store.put(briefKey, Buffer.from(enabledYaml));
    const exactBrief = materializeAndLoadBrief(this.deps.repoRoot, state, item, enabledYaml);
    const base = `${item.id}-brief-r${item.revision}`;
    return {
      artifacts: [
        {
          id: `${base}-selected`,
          kind: 'selected-brief',
          uri: this.deps.store.resolve(briefKey),
          summary:
            `${candidate.description}\n\nSelected candidate ${selected.index + 1}/3: ` +
            selected.rationale,
          provenance: `synth:${synthesis.providerLabel};selector:${selected.modelDeployment}`,
          briefId: exactBrief.brief.name,
        },
      ],
      evidence: [
        {
          id: `${base}-selection`,
          kind: 'brief-selection',
          uri: this.deps.store.resolve(briefKey),
          summary: JSON.stringify({
            selectedIndex: selected.index,
            rationale: selected.rationale,
            theme,
            promptHash: synthesis.promptHash,
          }),
          provenance: `selector:${selected.modelDeployment}`,
          briefId: exactBrief.brief.name,
        },
      ],
    };
  }

  private async generateSheetArtifacts(
    state: ThemeEquipmentSetState,
    item: ThemeEquipmentSetItem,
  ): Promise<{
    artifacts: readonly ThemeEquipmentArtifactEvidence[];
    evidence: readonly ThemeEquipmentArtifactEvidence[];
  }> {
    const { yaml, loaded } = await this.loadSelectedBrief(state, item);
    const briefPath = materializeAndLoadBrief(this.deps.repoRoot, state, item, yaml).briefPath;
    const generated = await generateOne({
      briefPath,
      preloaded: loaded,
      provider: this.requireImage(),
      textProvider: this.deps.textProvider,
      repoRoot: this.deps.repoRoot,
      store: this.deps.store,
      maxAttempts: 1,
      now: this.deps.now,
    });
    const briefId = generated.summary.brief;
    const runId = generated.summary.runId;
    const sheetFile = `sheet-${String(generated.summary.attempts - 1).padStart(2, '0')}.png`;
    const sheetKey = `${briefId}/${runId}/${sheetFile}`;
    if (!(await this.deps.store.has(sheetKey))) {
      throw new ThemeEquipmentRunnerError(`Generated run is missing its raw sheet: ${sheetKey}`);
    }
    const base = `${item.id}-sheet-r${item.revision}`;
    return {
      artifacts: [
        {
          id: `${base}-raw`,
          kind: 'raw-sheet',
          uri: this.deps.store.resolve(sheetKey),
          summary: sheetFile,
          provenance: 'generate-one',
          briefId,
          runId,
        },
      ],
      evidence: [
        {
          id: `${base}-run`,
          kind: 'generation-run',
          uri: generated.summaryPath,
          summary: `Raw sheet ${sheetFile}; attempts ${generated.attempts}`,
          provenance: 'generate-one',
          briefId,
          runId,
        },
      ],
    };
  }

  private async approveVariantArtifacts(
    state: ThemeEquipmentSetState,
    item: ThemeEquipmentSetItem,
  ): Promise<{
    artifacts: readonly ThemeEquipmentArtifactEvidence[];
    evidence: readonly ThemeEquipmentArtifactEvidence[];
  }> {
    const sheet = requiredArtifact(item, 'sprite-sheets', 'raw-sheet');
    if (!sheet.briefId || !sheet.runId) {
      throw new ThemeEquipmentRunnerError(`Raw sheet metadata is incomplete for "${item.id}".`);
    }
    const { yaml, loaded } = await this.loadSelectedBrief(state, item);
    materializeAndLoadBrief(this.deps.repoRoot, state, item, yaml);
    const summary = await loadRunSummary(this.deps.store, sheet.briefId, sheet.runId);
    await repostprocessRun({
      store: this.deps.store,
      briefId: sheet.briefId,
      runId: sheet.runId,
      summary,
      brief: loaded.brief,
      palette: loaded.palette,
    });
    const reprocessed = await loadRunSummary(this.deps.store, sheet.briefId, sheet.runId);
    const vision = this.requireVision();
    await rejudgeRun({
      store: this.deps.store,
      briefId: sheet.briefId,
      runId: sheet.runId,
      summary: reprocessed,
      brief: loaded.brief,
      referencePngs: loadRecordedReferencePngs({
        summary: reprocessed,
        repoRoot: this.deps.repoRoot,
      }),
      styleGuide: loadStyleGuide(this.deps.repoRoot),
      visionProvider: vision,
      force: true,
      // Speed the variant-approval rejudge (the maintainer-facing wait): cap the
      // judged set to at most 6 (never raising a brief that already asks for
      // fewer) and fan out 4-at-a-time. This path passes no judge budget/cache,
      // so bounded concurrency is race-free (see `runJudgePass`).
      judgeMaxVariants: Math.min(
        THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS,
        loaded.brief.judge.maxVariants,
      ),
      concurrency: THEME_EQUIPMENT_JUDGE_CONCURRENCY,
      env: this.deps.env,
      now: this.deps.now,
    });
    const judged = await loadRunSummary(this.deps.store, sheet.briefId, sheet.runId);
    const selection = autoSelectVariants(judged.candidates, { maxVariants: 3 });
    if (selection.selected.length < 1 || selection.selected.length > 3) {
      throw new RecoverableThemeSetItemError(
        `Variant approval found ${selection.selected.length} acceptable variants for "${item.id}"; required 1-3.`,
      );
    }
    const artifacts = selection.selected.map((entry) => {
      const processedKey = `${sheet.briefId}/${sheet.runId}/processed/${String(entry.index).padStart(2, '0')}.png`;
      return {
        id: `${item.id}-approved-r${item.revision}-v${entry.index}`,
        kind: THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
        uri: this.deps.store.resolve(processedKey),
        summary: `processed/${String(entry.index).padStart(2, '0')}.png`,
        provenance: 'repostprocess-run;rejudge-run;auto-select-variants',
        briefId: sheet.briefId,
        runId: sheet.runId,
        variantIndex: entry.index,
      } satisfies ThemeEquipmentArtifactEvidence;
    });
    return {
      artifacts,
      evidence: [
        {
          id: `${item.id}-approval-evidence-r${item.revision}`,
          kind: 'judge-sensor-evidence',
          uri: this.deps.store.resolve(`${sheet.briefId}/${sheet.runId}/summary.json`),
          summary: JSON.stringify({
            selected: selection.selected.map((entry) => ({
              variantIndex: entry.index,
              sensor: `${entry.score}/${entry.outOf}`,
              judge: entry.judgeScorecard?.minScore ?? null,
            })),
            rejected: selection.rejected,
          }),
          provenance: 'rejudge-run;auto-select-variants',
          briefId: sheet.briefId,
          runId: sheet.runId,
        },
      ],
    };
  }

  private async judgePhaseCollection(state: ThemeEquipmentSetState) {
    if (state.phase === 'roster' || state.phase === 'briefs') {
      return this.judgeTextCollection(state, state.phase);
    }
    const sources = selectCollectionTileSources(state);
    const tiles = await Promise.all(
      sources.map((source) =>
        this.deps.store.get(source.key).then((png) => ({ label: source.label, png })),
      ),
    );
    return judgeThemeEquipmentCollectionWithVision({
      state,
      tiles,
      provider: this.requireVision(),
      env: this.deps.env,
    });
  }

  private async judgeTextCollection(state: ThemeEquipmentSetState, phase: 'roster' | 'briefs') {
    const summaries = state.items.map((item) => {
      const record = item.phases[phase];
      const text =
        phase === 'roster'
          ? record.artifacts.map((artifact) => artifact.summary ?? item.displayName).join('\n')
          : record.artifacts.map((artifact) => artifact.summary ?? artifact.uri).join('\n');
      return { label: item.displayName, text };
    });
    return judgeThemeEquipmentCollectionWithText({
      state,
      summaries,
      provider: createVisionTextJudgeProvider(this.requireVision()),
      env: this.deps.env,
    });
  }

  private async loadSelectedBrief(state: ThemeEquipmentSetState, item: ThemeEquipmentSetItem) {
    const selected = item.phases.briefs.artifacts.find(
      (artifact) => artifact.kind === 'selected-brief',
    );
    if (!selected) {
      throw new ThemeEquipmentRunnerError(`Item "${item.id}" has no selected brief artifact.`);
    }
    const revision = selectedBriefRevision(selected.id, item.revision);
    const yaml = (await this.deps.store.get(selectedBriefKey(state, item, revision))).toString(
      'utf8',
    );
    const loaded = materializeAndLoadBrief(this.deps.repoRoot, state, item, yaml, revision);
    return { yaml, loaded };
  }

  private async stageApprovedAssets(
    state: ThemeEquipmentSetState,
    stageRoot: string,
  ): Promise<CheckinAsset[]> {
    __stageThemeEquipmentArtSurface(this.deps.repoRoot, stageRoot);
    const stagedRuns = new Set<string>();
    const assets: CheckinAsset[] = [];
    for (const item of state.items) {
      const approved = item.phases['variant-approval'].artifacts.filter(
        (artifact) => artifact.kind === THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
      );
      for (const artifact of approved) {
        if (!artifact.briefId || !artifact.runId || artifact.variantIndex === undefined) {
          throw new ThemeEquipmentRunnerError(
            `Approved variant metadata is incomplete for "${item.id}".`,
          );
        }
        const runKey = `${artifact.briefId}/${artifact.runId}`;
        if (!stagedRuns.has(runKey)) {
          await __stageThemeEquipmentRun(
            this.deps.store,
            stageRoot,
            artifact.briefId,
            artifact.runId,
          );
          stagedRuns.add(runKey);
        }
        const entry = this.approveStagedVariant(
          stageRoot,
          artifact.briefId,
          artifact.runId,
          artifact.variantIndex,
        );
        assets.push({
          assetPath: entry.assetPath,
          manifestKey: entry.spriteName,
          // State identity is the exact source brief identity, even when
          // approveVariant canonicalizes a gameplay-facing manifest key.
          briefId: artifact.briefId,
          variantIndex: artifact.variantIndex,
          ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
        });
      }
    }
    return assets;
  }

  private approveStagedVariant(
    stageRoot: string,
    briefId: string,
    runId: string,
    variantIndex: number,
  ): ManifestEntry {
    const runDir = path.join(stageRoot, 'generated', 'runs', briefId, runId);
    return approveVariant({
      runDir,
      variantIndex,
      manifestPath: path.join(stageRoot, 'public', 'assets', 'generated', 'manifest.json'),
      catalogPath: path.join(stageRoot, 'src', 'shared', 'data', 'sprite-catalog.json'),
      publicAssetsDir: path.join(stageRoot, 'public', 'assets'),
      repoRoot: stageRoot,
      sourceRunOverride: `generated/runs/${briefId}/${runId}`,
      now: this.deps.now,
      allowReapprove: true,
    });
  }

  private requireVision(): VisionProvider {
    if (!this.deps.visionProvider) {
      throw new ThemeEquipmentRunnerError(
        'Theme-equipment collection and individual variant judging require AZURE_OPENAI_VISION_DEPLOYMENT.',
      );
    }
    return this.deps.visionProvider;
  }

  private requireSynth(): ReturnType<typeof createSynthProvider> {
    if (!this.deps.synthProvider) {
      throw new ThemeEquipmentRunnerError(
        'Theme-equipment brief synthesis requires configured Azure synthesis credentials.',
      );
    }
    return this.deps.synthProvider;
  }

  private requireImage(): ImageProvider {
    if (!this.deps.imageProvider) {
      throw new ThemeEquipmentRunnerError(
        'Theme-equipment sheet generation requires configured Azure image credentials.',
      );
    }
    return this.deps.imageProvider;
  }

  private async requireState(setId: string): Promise<ThemeEquipmentSetState> {
    const state = await loadThemeEquipmentSetState(this.deps.store, setId);
    if (!state) throw new ThemeEquipmentRunnerError(`Theme set "${setId}" was not found.`);
    return state;
  }

  private makeStageRoot(): string {
    if (this.deps.makeStageRoot) return this.deps.makeStageRoot();
    const stageParent = path.join(this.deps.repoRoot, 'generated');
    mkdirSync(stageParent, { recursive: true });
    return mkdtempSync(path.join(stageParent, STAGE_PREFIX));
  }

  private removeStageRoot(root: string): void {
    if (this.deps.removeStageRoot) {
      this.deps.removeStageRoot(root);
      return;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function requiredArtifact(
  item: ThemeEquipmentSetItem,
  phase: 'sprite-sheets' | 'variant-approval',
  kind: string,
): ThemeEquipmentArtifactEvidence {
  const artifact = item.phases[phase].artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) {
    throw new ThemeEquipmentRunnerError(
      `Item "${item.id}" has no ${kind} artifact for phase "${phase}".`,
    );
  }
  return artifact;
}

/**
 * One PNG tile to fetch for a vision collection-cohesion contact sheet: the
 * run-store key of the image and the label the judge prompt uses to refer to
 * it.
 */
export interface CollectionTileSource {
  readonly key: string;
  readonly label: string;
}

/**
 * Choose the contact-sheet tiles for the collection-cohesion vision judge at
 * the `sprite-sheets` or `variant-approval` phase. Returns EXACTLY ONE tile
 * per item, in `state.items` order.
 *
 * Collection cohesion is a cross-item judgment — whether the items read as a
 * single coherent set — so one representative image per item is the right
 * granularity. Per-variant quality was already judged during variant
 * selection/approval. One tile per item also keeps the sheet within
 * `CONTACT_SHEET_MAX_TILES` for large sets (N items = N tiles, never
 * N × variants — an 18-item set with 3 approved variants each previously
 * assembled 54 tiles and overflowed the 32 cap at the very end of a paid run)
 * and keeps each sprite large enough for the vision model to read.
 *
 * For `variant-approval` the representative is the approved variant with the
 * LOWEST `variantIndex` — a deterministic tiebreak that does not depend on the
 * durable artifact array's order. Every approved variant is by definition
 * acceptable, so any is a valid stand-in. The metadata of EVERY approved
 * variant is validated before selection, so a malformed unselected artifact
 * fails loudly here rather than surviving to a later publish step.
 *
 * Throws `ThemeEquipmentRunnerError` for an unsupported phase, an item with no
 * approved variants, or incomplete artifact metadata.
 */
export function selectCollectionTileSources(state: ThemeEquipmentSetState): CollectionTileSource[] {
  switch (state.phase) {
    case 'sprite-sheets':
      return state.items.map((item) => {
        const artifact = requiredArtifact(item, 'sprite-sheets', 'raw-sheet');
        if (!artifact.briefId || !artifact.runId || !artifact.summary) {
          throw new ThemeEquipmentRunnerError(
            `Collection artifact metadata is incomplete for "${item.id}".`,
          );
        }
        return {
          key: `${artifact.briefId}/${artifact.runId}/${artifact.summary}`,
          label: item.displayName,
        };
      });
    case 'variant-approval':
      return state.items.map((item) => {
        const approved = item.phases['variant-approval'].artifacts.filter(
          (artifact) => artifact.kind === THEME_EQUIPMENT_APPROVED_VARIANT_ARTIFACT_KIND,
        );
        if (approved.length === 0) {
          throw new ThemeEquipmentRunnerError(
            `Item "${item.id}" has no approved-variant artifacts for collection judging.`,
          );
        }
        for (const artifact of approved) {
          if (!artifact.briefId || !artifact.runId || artifact.variantIndex === undefined) {
            throw new ThemeEquipmentRunnerError(
              `Collection artifact metadata is incomplete for "${item.id}".`,
            );
          }
        }
        const representative = approved.reduce((lowest, candidate) => {
          const candidateIndex = candidate.variantIndex ?? Number.POSITIVE_INFINITY;
          const lowestIndex = lowest.variantIndex ?? Number.POSITIVE_INFINITY;
          return candidateIndex < lowestIndex ? candidate : lowest;
        });
        const filename = `processed/${String(representative.variantIndex).padStart(2, '0')}.png`;
        return {
          key: `${representative.briefId}/${representative.runId}/${filename}`,
          label: item.displayName,
        };
      });
    default:
      throw new ThemeEquipmentRunnerError(
        `selectCollectionTileSources does not support phase "${state.phase}".`,
      );
  }
}

/**
 * Bounded concurrency for the publish stager's Azure blob downloads. Each key
 * writes to its own distinct path with an idempotent recursive mkdir, so the
 * reads are independent — the only shared coupling is the outer cleanup of
 * `stageRoot` on failure, which is why a rejecting batch must fully settle
 * before it throws (below). 4 matches THEME_EQUIPMENT_JUDGE_CONCURRENCY; the
 * installed Azure retry policy does not retry HTTP 429, so a higher fan-out
 * would raise burst/throttle risk without a matching benefit.
 */
export const THEME_EQUIPMENT_STAGE_DOWNLOAD_CONCURRENCY = 4;

export async function __stageThemeEquipmentRun(
  store: RunStore,
  stageRoot: string,
  briefId: string,
  runId: string,
): Promise<void> {
  const prefix = `${briefId}/${runId}/`;
  const keys = await store.list(prefix, { authoritative: true });
  if (keys.length === 0) {
    throw new ThemeEquipmentRunnerError(`No stored run artifacts found under ${prefix}`);
  }
  const runDir = path.join(stageRoot, 'generated', 'runs', briefId, runId);
  const downloadKey = async (key: string): Promise<void> => {
    const relative = key.slice(prefix.length);
    const destination = path.join(runDir, ...relative.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, await store.get(key));
  };
  for (let index = 0; index < keys.length; index += THEME_EQUIPMENT_STAGE_DOWNLOAD_CONCURRENCY) {
    const batch = keys.slice(index, index + THEME_EQUIPMENT_STAGE_DOWNLOAD_CONCURRENCY);
    // Settle the whole batch before propagating a failure: the caller deletes
    // `stageRoot` on rejection, so no in-flight write may outlive this throw.
    const results = await Promise.allSettled(batch.map(downloadKey));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure && failure.status === 'rejected') {
      throw failure.reason;
    }
  }
}

export function __stageThemeEquipmentArtSurface(repoRoot: string, stageRoot: string): void {
  const generatedAssets = path.join(repoRoot, 'public', 'assets', 'generated');
  if (existsSync(generatedAssets)) {
    cpSync(generatedAssets, path.join(stageRoot, 'public', 'assets', 'generated'), {
      recursive: true,
    });
  }
  const catalog = path.join(repoRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  const stagedCatalog = path.join(stageRoot, 'src', 'shared', 'data', 'sprite-catalog.json');
  mkdirSync(path.dirname(stagedCatalog), { recursive: true });
  copyFileSync(catalog, stagedCatalog);
}
