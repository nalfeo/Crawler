/**
 * variant-lifecycle.mjs — per-VARIANT lifecycle classification for the Workflow
 * canvas: `unaccepted` | `accepted-staged` | `integrated` | `unverified`.
 *
 * Extracted as a small, pure, dependency-free module (no fs/network) so the
 * classification rules are unit-testable in isolation from the extension's
 * server wiring — this is exactly the logic the plan review's per-variant
 * provenance concern is about, so it gets its own focused test file rather
 * than only being exercised indirectly through `extension.mjs`.
 *
 * NEVER infers lifecycle from "this run is promoted" alone: a run can be
 * promoted because a DIFFERENT variant of it won, so every check matches the
 * EXACT `{briefId, runId, variantIndex}` triple against the backlog's
 * per-asset manifest selection (see `findMatchingAsset` /
 * `workflow-model.mjs`'s `sourceRunMatchesRun`). When provenance is
 * incomplete — the sprite/item registry could not be resolved, or the
 * manifest-approved file is missing on disk — the state is the explicit
 * `unverified`, never a guessed `integrated`/`accepted-staged`.
 *
 * A manifest-approved variant with NO corresponding art-plan asset (verified
 * against a live sidecar + this repo's real manifest during development — see
 * the `iron-cleaver` case in the module's tests) would otherwise show as
 * `unaccepted` even though it plainly has a manifest entry, since the
 * backlog's `reports[].assets[]` is scoped to PLAN-declared assets only. Such
 * a variant falls back to matching the raw `manifestApprovals` list instead —
 * it can only ever resolve to `accepted-staged`/`unverified` there (never
 * `integrated`: without a plan asset there is no declared runtime-integration
 * target to confirm against).
 *
 * @module workflow/variant-lifecycle
 */
import { sourceRunMatchesRun } from './workflow-model.mjs';

/**
 * Find the backlog asset (if any) whose manifest entry selects this EXACT
 * variant: same briefId, same variantIndex, AND a `sourceRun` that resolves to
 * this exact `{briefId, runId}` run.
 * @param {object[]} reports  `stat.backlog.reports`
 * @param {string} briefId
 * @param {string} runId
 * @param {number} variantIndex
 * @returns {object | null}
 */
export function findMatchingAsset(reports, briefId, runId, variantIndex) {
  for (const report of reports ?? []) {
    for (const asset of report.assets ?? []) {
      // Skip the briefId equality check: approveVariant canonicalizes item brief
      // IDs (e.g. `flame-dagger-v2` → `flame-dagger`), so asset.briefId may
      // differ from the caller's raw run briefId. The sourceRun path check below
      // encodes the original run directory (using the raw briefId), so it is
      // sufficient to uniquely identify the run without a duplicate briefId guard.
      if (asset.variantIndex !== variantIndex) continue;
      if (!sourceRunMatchesRun(asset.sourceRun, briefId, runId)) continue;
      return asset;
    }
  }
  return null;
}

/**
 * Find the raw manifest approval (if any) that selects this EXACT variant —
 * the fallback used when no art-plan asset references this briefId at all.
 * @param {object[]} manifestApprovals  `loadBacklog(...).manifestApprovals`
 * @returns {object | null}
 */
export function findMatchingManifestApproval(manifestApprovals, briefId, runId, variantIndex) {
  for (const approval of manifestApprovals ?? []) {
    // Skip the briefId equality check: approveVariant canonicalizes item brief
    // IDs (e.g. `flame-dagger-v2` → `flame-dagger`), so approval.briefId in
    // the manifest may differ from the caller's raw run briefId. The sourceRun
    // path encodes the original run directory and is sufficient to identify the
    // match without a separate briefId guard.
    if (approval.variantIndex !== variantIndex) continue;
    if (!sourceRunMatchesRun(approval.sourceRun, briefId, runId)) continue;
    return approval;
  }
  return null;
}

/**
 * Per-VARIANT lifecycle. Computed fresh from the CURRENT fs-backed backlog
 * reports + an in-memory `acceptanceEntry` (this session's own optimistic
 * "just queued" bookkeeping) — never cached, never inferred from run-level
 * promotion alone.
 *
 * @param {{
 *   backlogReports: object[],
 *   manifestApprovals?: object[],
 *   acceptanceEntry: { state?: string } | null | undefined,
 *   briefId: string,
 *   runId: string,
 *   variantIndex: number,
 * }} args
 * @returns {{ state: 'unaccepted'|'accepted-staged'|'integrated'|'unverified', detail: string | null, manifestKey: string | null }}
 */
export function computeVariantLifecycle({
  backlogReports,
  manifestApprovals,
  acceptanceEntry,
  briefId,
  runId,
  variantIndex,
}) {
  const matched = findMatchingAsset(backlogReports, briefId, runId, variantIndex);
  if (matched) {
    // Derive the canonical manifest key from the asset's assetPath
    // (e.g. "generated/flame-dagger-var-1.png" → "flame-dagger-var-1").
    // This is authoritative: approveVariant writes assetPath as
    // `generated/${manifestKey}.png`, so reversing it always gives the
    // exact key even when approveVariant canonicalized the briefId.
    const assetPath = matched.assetPath ?? null;
    const manifestKey =
      assetPath && assetPath.startsWith('generated/') && assetPath.endsWith('.png')
        ? assetPath.slice('generated/'.length, -'.png'.length)
        : null;
    if (!matched.approvedAssetExists) {
      return {
        state: 'unverified',
        detail: 'Approved asset file is missing on disk.',
        manifestKey,
      };
    }
    if (matched.integrationState === 'unverified') {
      return {
        state: 'unverified',
        detail: 'Sprite/item registry could not be loaded to confirm runtime integration.',
        manifestKey,
      };
    }
    if (matched.integrationState === 'integrated') {
      return { state: 'integrated', detail: null, manifestKey };
    }
    // 'missing' (declared integration target not found) or 'not-applicable'
    // (no integration target declared) — approved/selected but not confirmed
    // wired into a runtime registry/catalog.
    return { state: 'accepted-staged', detail: null, manifestKey };
  }

  const manifestOnly = findMatchingManifestApproval(
    manifestApprovals,
    briefId,
    runId,
    variantIndex,
  );
  if (manifestOnly) {
    // mapKey is the authoritative manifest map key carried through from
    // listManifestApprovals. Fall back to null when the caller does not
    // provide it (e.g. older call sites that pre-date this field).
    const manifestKey = manifestOnly.mapKey ?? null;
    if (!manifestOnly.exists) {
      return {
        state: 'unverified',
        detail: 'Approved asset file is missing on disk.',
        manifestKey,
      };
    }
    return {
      state: 'accepted-staged',
      detail:
        'Approved in the generated manifest but has no art-plan asset to confirm runtime integration against.',
      manifestKey,
    };
  }

  if (acceptanceEntry && acceptanceEntry.state === 'queued') {
    return {
      state: 'accepted-staged',
      detail: 'Queued for check-in this session; not yet reflected in the generated manifest.',
      manifestKey: null,
    };
  }
  return { state: 'unaccepted', detail: null, manifestKey: null };
}
