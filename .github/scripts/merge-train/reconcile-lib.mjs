import {
  BLOCKED_LABEL,
  QUEUE_LABEL,
  candidateFingerprint,
  commitTimestamp,
  renderStatus,
} from './state.mjs';

export class MergeTrainConflictError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MergeTrainConflictError';
  }
}

export class MergeTrainNoopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeTrainNoopError';
  }
}

export function isMergeTrainConflictError(error) {
  return error instanceof MergeTrainConflictError;
}

export function isMergeTrainNoopError(error) {
  return error instanceof MergeTrainNoopError;
}

export function trainCheckTitle(status, conclusion) {
  if (status !== 'completed') return 'Merge-train validation queued';
  return conclusion === 'success'
    ? 'Candidate promoted to main'
    : 'Merge-train validation could not start';
}

function hasLabel(pr, name) {
  return (pr.labels || []).some((label) => label.name === name);
}

function sameRepository(pr, repository) {
  return pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase();
}

function fetchCandidateHead(git, entry) {
  const refName = `refs/remotes/merge-train/pr-${entry.number}`;
  const expectedSha = String(entry.head?.sha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error(`PR #${entry.number} has invalid API head SHA: ${expectedSha || '<empty>'}`);
  }
  try {
    git(['fetch', 'origin', `${expectedSha}:${refName}`, '--force']);
  } catch (shaError) {
    const headRef = String(entry.head?.ref || '').trim();
    if (!headRef) {
      throw new Error(
        `PR #${entry.number} head ${expectedSha} is not fetchable and has no branch ref fallback: ${shaError.message}`,
        { cause: shaError },
      );
    }
    git(['fetch', 'origin', `refs/heads/${headRef}:${refName}`, '--force']);
  }
  const fetchedSha = git(['rev-parse', refName]);
  if (fetchedSha !== expectedSha) {
    throw new Error(
      `PR #${entry.number} head changed while building candidate (expected ${expectedSha}, got ${fetchedSha}); reconcile will retry on the next run`,
    );
  }
  return refName;
}

function gitCommandSucceeded(git, args) {
  try {
    git(args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

const CANDIDATE_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'crawler-merge-train[bot]',
  GIT_AUTHOR_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'crawler-merge-train[bot]',
  GIT_COMMITTER_EMAIL: 'crawler-merge-train[bot]@users.noreply.github.com',
};

export function resolveMergeTrainTokens(environment) {
  const liveActionsRun = environment.GITHUB_ACTIONS === 'true';
  const promotionToken =
    environment.MERGE_TRAIN_TOKEN || (!liveActionsRun ? environment.GITHUB_TOKEN || '' : '');
  const workflowDispatchToken =
    environment.GITHUB_TOKEN || (!liveActionsRun ? environment.MERGE_TRAIN_TOKEN || '' : '');
  if (!promotionToken) {
    throw new Error('Merge train requires MERGE_TRAIN_TOKEN for promotion operations');
  }
  if (!workflowDispatchToken) {
    throw new Error('Merge train requires GITHUB_TOKEN for workflow dispatch operations');
  }
  return { promotionToken, workflowDispatchToken };
}

export async function dispatchRecoveryWorkflow({ request, token, owner, repo, prNumber, trigger }) {
  await request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
    method: 'POST',
    body: {
      ref: 'main',
      inputs: {
        operation: 'reconcile',
        pr_number: String(prNumber),
        trigger,
        lease_id: '',
      },
    },
  });
}

export async function dispatchValidationWorkflow({
  request,
  token,
  owner,
  repo,
  sha,
  fingerprint,
  entries,
}) {
  await request(
    token,
    `/repos/${owner}/${repo}/actions/workflows/merge-train-validate.yml/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          candidate_sha: sha,
          fingerprint,
          pr_numbers: entries.map((entry) => entry.number).join(','),
        },
      },
    },
  );
}

export function buildCandidate({ baseSha, entries, refName, git, live }) {
  git(['fetch', 'origin', 'main', '--prune']);
  const candidateRefs = entries.map((entry) => fetchCandidateHead(git, entry));
  git(['checkout', '--detach', baseSha]);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const candidateRef = candidateRefs[index];
    try {
      git(['merge', '--squash', '--no-commit', candidateRef], {
        env: CANDIDATE_GIT_IDENTITY,
      });
    } catch (error) {
      let hasUnmergedEntries = false;
      let operationalError = error;
      try {
        hasUnmergedEntries = git(['ls-files', '--unmerged']).trim().length > 0;
      } catch (inspectionError) {
        operationalError = new Error(
          `could not inspect the failed candidate merge: ${inspectionError.message}`,
          { cause: error },
        );
      }
      git(['reset', '--hard', baseSha]);
      if (hasUnmergedEntries) {
        throw new MergeTrainConflictError(
          `PR #${entry.number} conflicts in the cumulative candidate: ${error.message}`,
          { cause: error },
        );
      }
      throw new Error(
        `PR #${entry.number} candidate merge failed operationally: ${operationalError.message}`,
        { cause: operationalError },
      );
    }
    if (gitCommandSucceeded(git, ['diff', '--cached', '--quiet'])) {
      throw new MergeTrainNoopError(
        `PR #${entry.number} no longer changes main; its squash diff is already present in the candidate base`,
      );
    }
    const title = String(entry.title)
      .replace(/[\r\n]+/g, ' ')
      .trim();
    const timestamp = commitTimestamp(entry);
    git(
      [
        'commit',
        '-m',
        `${title} (#${entry.number})`,
        '-m',
        `Merge-Train-PR: ${entry.number}\nMerge-Train-Original-Head: ${entry.head.sha}`,
      ],
      {
        env: {
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_DATE: timestamp,
          ...CANDIDATE_GIT_IDENTITY,
        },
      },
    );
  }
  const sha = git(['rev-parse', 'HEAD']);
  if (live) {
    git(['push', '--force', 'origin', `${sha}:refs/heads/${refName}`]);
  }
  return sha;
}

/**
 * Determine whether a schedule-triggered CI run executed the full gate or was
 * a disabled-train no-op. When `MERGE_TRAIN_ENABLED=false`, `ci.yml` gates
 * the `changes` (Detect change scope) job on the flag, so a scheduled run
 * with the flag off completes as `success` without running any real CI jobs.
 * A no-op schedule run is NOT authoritative main-health evidence: after the
 * flag is re-enabled, it could outrank a genuine failed push and let promotion
 * proceed from a red `main`.
 *
 * `jobs` is the list of workflow-run jobs from the GitHub Actions API
 * (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`).
 *
 * Returns `true` when the run is NOT full-CI evidence (disabled-train no-op
 * or jobs data is unavailable). Fails closed: if no jobs are returned or the
 * `changes` job is absent, the run cannot be confirmed as full CI.
 */
export function isDisabledTrainScheduleRun(jobs) {
  if (!jobs || jobs.length === 0) return true;
  const changesJob = jobs.find((job) => job.name === 'Detect change scope');
  return !changesJob || changesJob.conclusion === 'skipped';
}

/**
 * Decide whether main currently has authoritative full-CI ("ci.yml", the
 * `CI` workflow) evidence for the exact SHA it is on right now, considering
 * both hourly `schedule` runs and `push` runs but excluding push runs that
 * merely attest a merge-train fast-path shortcut (`isTrainFastPath: true`;
 * their own green conclusion is not full-CI evidence). Fails closed: no
 * evidence, or evidence that is still pending, is treated as NOT healthy,
 * so the circuit breaker cannot be bypassed by an empty/incomplete run list.
 */
export function mainHealthReason({ mainSha, runs }) {
  const authoritative = (runs || [])
    .filter((run) => run.head_sha === mainSha && run.name === 'CI' && !run.isTrainFastPath)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const latest = authoritative[0];
  if (!latest) return `no full-CI evidence yet for current main ${mainSha}`;
  if (latest.status !== 'completed') {
    return `full-CI run for current main ${mainSha} is still ${latest.status}`;
  }
  if (latest.conclusion !== 'success') {
    return `latest full-CI run for current main ${mainSha} concluded ${latest.conclusion}`;
  }
  return null;
}

export function promotionStaleReason({ currentMain, currentPr, expectedBase, pr, repository }) {
  if (currentMain !== expectedBase) return 'main moved since validation';
  if (currentPr.head?.sha !== pr.head?.sha) return 'PR head changed since validation';
  if (currentPr.title !== pr.title) return 'PR title changed since validation';
  if (currentPr.state !== 'open') return 'PR is no longer open';
  if (currentPr.draft) return 'PR is now a draft';
  if (currentPr.base?.ref !== 'main')
    return `PR retargeted to ${currentPr.base?.ref || '<unknown>'}`;
  if (!sameRepository(currentPr, repository)) return 'PR head repository changed';
  if (!hasLabel(currentPr, QUEUE_LABEL)) return `PR no longer has the ${QUEUE_LABEL} label`;
  if (hasLabel(currentPr, BLOCKED_LABEL)) return `PR is marked ${BLOCKED_LABEL}`;
  return null;
}

export async function promoteExactCandidate({
  pr,
  candidateSha,
  expectedBase,
  position,
  repository,
  live,
  fetchCurrentPr,
  fetchCurrentMain,
  eligible,
  git,
  createTrainCheck,
  removeLabel,
  updateStatus,
  requiredCheckName,
  provenanceEntries = [pr],
  waitForMergedPr,
  reattestHealth,
}) {
  return promoteExactBatch({
    entries: [pr],
    candidateShas: [candidateSha],
    expectedBase,
    repository,
    live,
    fetchCurrentPr: async () => fetchCurrentPr(),
    fetchCurrentMain,
    eligible,
    git,
    createTrainCheck,
    removeLabel,
    updateStatus,
    requiredCheckName,
    provenanceEntries,
    positions: [position],
    waitForMergedPr,
    reattestHealth,
  });
}

export async function promoteExactBatch({
  entries,
  candidateShas,
  expectedBase,
  repository,
  live,
  fetchCurrentPr,
  fetchCurrentMain,
  eligible,
  git,
  createTrainCheck,
  removeLabel,
  updateStatus,
  requiredCheckName,
  provenanceEntries = entries,
  positions = entries.map((_, index) => index + 1),
  waitForMergedPr = async () => true,
  reattestHealth = async () => true,
}) {
  if (entries.length === 0 || entries.length !== candidateShas.length) {
    throw new Error('Promotion requires one candidate SHA per non-empty PR entry');
  }
  const currentMain = await fetchCurrentMain();
  const currentPrs = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const currentPr = await fetchCurrentPr(entry, index);
    const staleReason = promotionStaleReason({
      currentMain,
      currentPr,
      expectedBase,
      pr: entry,
      repository,
    });
    if (staleReason) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${staleReason}; rebuilding on next reconcile\n`,
      );
      return false;
    }
    const admission = await eligible(currentPr);
    if (!admission.ok) {
      process.stdout.write(`blocked promotion pr=#${entry.number} reason=${admission.reason}\n`);
      return false;
    }
    const expectedParent = index === 0 ? expectedBase : candidateShas[index - 1];
    const parent = git(['rev-parse', `${candidateShas[index]}^`]);
    if (parent !== expectedParent) {
      throw new Error(
        `Candidate ${candidateShas[index]} is not a direct child of ${expectedParent}`,
      );
    }
    const headRef = currentPr.head.ref;
    if (!/^[A-Za-z0-9._/-]+$/.test(headRef)) {
      throw new Error(`Unsafe PR head ref: ${headRef}`);
    }
    currentPrs.push(currentPr);
  }
  if (!live) {
    process.stdout.write(
      `dry-run would-promote prs=${entries.map((entry) => `#${entry.number}`).join(',')} sha=${candidateShas.at(-1)}\n`,
    );
    return false;
  }
  const finalMain = await fetchCurrentMain();
  if (finalMain !== expectedBase) {
    process.stdout.write('stale promotion; main moved during final reattestation\n');
    return false;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const finalPr = await fetchCurrentPr(entry, index);
    const staleReason = promotionStaleReason({
      currentMain: finalMain,
      currentPr: finalPr,
      expectedBase,
      pr: entry,
      repository,
    });
    const admission = staleReason ? null : await eligible(finalPr);
    if (staleReason || !admission.ok) {
      process.stdout.write(
        `stale promotion pr=#${entry.number}; ${staleReason || admission.reason}; final reattestation failed\n`,
      );
      return false;
    }
    currentPrs[index] = finalPr;
  }
  // Re-run the main-health guard here, immediately before publishing the
  // required check and updating refs. The initial guard (mainHealthAllowsPromotion)
  // runs once per reconcile before the sequential PR/admission reads above;
  // a scheduled or push-triggered CI run for main can start and go
  // pending/red while those reads are in flight, which would otherwise let a
  // now-unhealthy main get promoted past. Reusing the same trusted, token
  // authenticated health check here (rather than trusting the earlier
  // result) closes that window without any unauthenticated or stale
  // shortcut.
  if (!(await reattestHealth())) {
    process.stdout.write('paused merge train; main health changed during final reattestation\n');
    return false;
  }
  const finalCandidateSha = candidateShas.at(-1);
  const promotionFingerprint = candidateFingerprint(expectedBase, currentPrs);
  await createTrainCheck(
    finalCandidateSha,
    promotionFingerprint,
    'completed',
    'success',
    requiredCheckName,
    provenanceEntries,
  );
  try {
    const refUpdates = currentPrs.map(
      (currentPr) => `${finalCandidateSha}:refs/heads/${currentPr.head.ref}`,
    );
    const leases = currentPrs.map(
      (currentPr) => `--force-with-lease=refs/heads/${currentPr.head.ref}:${currentPr.head.sha}`,
    );
    git([
      'push',
      '--atomic',
      'origin',
      ...refUpdates,
      `${finalCandidateSha}:refs/heads/main`,
      ...leases,
      `--force-with-lease=refs/heads/main:${expectedBase}`,
    ]);
  } catch (error) {
    await createTrainCheck(
      finalCandidateSha,
      promotionFingerprint,
      'completed',
      'failure',
      requiredCheckName,
      provenanceEntries,
    );
    throw error;
  }
  // The atomic `git push --atomic ... --force-with-lease` above already
  // succeeded (no exception was thrown), which is the actual, authoritative
  // proof that every entry's head ref *and* main were fast-forwarded to
  // `finalCandidateSha`. `waitForMergedPr` below is a secondary confirmation
  // via GitHub's own view of each PR (useful for auditability and to catch a
  // genuinely wrong assumption), but it does NOT poll for GitHub's `merged`/
  // `merged_at` fields to flip true -- those are only ever set when a PR is
  // closed through GitHub's own merge machinery (its Merge API or the web
  // "Merge" button), which this atomic multi-ref force-push strategy
  // intentionally bypasses to get true cross-PR atomicity. This was
  // originally believed to be an async *lag* under load (ADR 0062 DEC-024:
  // a six-PR batch where the first entry's confirmation read hadn't landed
  // within the old retry budget), but was proven live on 2026-07-15 to be
  // *permanent*, not a lag (ADR 0062 DEC-025): seven real promoted PRs across
  // two separate batches -- one over nine hours old -- never showed
  // `merged: true`, despite `git log main --grep Merge-Train-PR` proving
  // every one of their commits correctly landed. `waitForMergedPr` (built by
  // `createWaitForMergedPr` above) instead polls for `state === 'closed'`,
  // which GitHub reliably sets within ~20s of the push in every observed
  // case, and is the actual achievable ground-truth signal for this
  // promotion mechanism.
  //
  // The entire post-push phase below is therefore "collect failures, never
  // abort early, throw once at the end" -- not just the confirmation check,
  // but also cleanup (`removeLabel`/`updateStatus`) and publishing the
  // postcondition failure check itself, since *any* of those throwing partway
  // through can equally strand an already-confirmed sibling with a stale
  // `merge-train` label (closed PRs are invisible to the next reconcile's
  // `state=open` queue query, so nothing else will ever clean that label up).
  // Confirmation reads run in parallel (not sequentially) so one entry's slow
  // confirmation doesn't multiply the wall-clock budget by batch size.
  const confirmations = await Promise.all(
    entries.map(async (entry) => {
      try {
        const merged = await waitForMergedPr(entry, finalCandidateSha);
        return { entry, merged, reason: null };
      } catch (error) {
        return {
          entry,
          merged: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const unconfirmed = confirmations.filter((confirmation) => !confirmation.merged);
  let postconditionCheckError = null;
  if (unconfirmed.length > 0) {
    try {
      await createTrainCheck(
        finalCandidateSha,
        promotionFingerprint,
        'completed',
        'failure',
        `${requiredCheckName}-promotion-postcondition`,
        provenanceEntries,
      );
    } catch (error) {
      postconditionCheckError = error instanceof Error ? error.message : String(error);
    }
  }
  const unconfirmedEntries = new Set(unconfirmed.map((confirmation) => confirmation.entry));
  const cleanupFailures = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (unconfirmedEntries.has(entry)) continue;
    try {
      await removeLabel(entry.number, QUEUE_LABEL);
      await removeLabel(entry.number, BLOCKED_LABEL);
      await updateStatus(
        entry.number,
        renderStatus({
          position: positions[index],
          candidateSha: finalCandidateSha,
          state: 'merged',
          detail: 'The exact validated combined candidate fast-forwarded main atomically.',
        }),
      );
    } catch (error) {
      cleanupFailures.push({
        entry,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failureParts = [];
  if (unconfirmed.length > 0) {
    failureParts.push(
      `PR${unconfirmed.length > 1 ? 's' : ''} ${unconfirmed
        .map((confirmation) =>
          confirmation.reason
            ? `#${confirmation.entry.number} (confirmation check errored: ${confirmation.reason})`
            : `#${confirmation.entry.number}`,
        )
        .join(
          ', ',
        )} ${unconfirmed.length > 1 ? 'were' : 'was'} not recorded as merged after atomic promotion to ${finalCandidateSha}`,
    );
  }
  if (cleanupFailures.length > 0) {
    failureParts.push(
      `cleanup failed for confirmed PR${cleanupFailures.length > 1 ? 's' : ''} ${cleanupFailures
        .map((failure) => `#${failure.entry.number} (${failure.reason})`)
        .join(', ')} after atomic promotion to ${finalCandidateSha}`,
    );
  }
  if (postconditionCheckError) {
    failureParts.push(
      `failed to publish the ${requiredCheckName}-promotion-postcondition failure check: ${postconditionCheckError}`,
    );
  }
  if (failureParts.length > 0) {
    throw new Error(failureParts.join('; '));
  }
  process.stdout.write(
    `promoted prs=${entries.map((entry) => `#${entry.number}`).join(',')} sha=${finalCandidateSha}\n`,
  );
  return true;
}

/**
 * Whether a PR's current GitHub state is acceptable confirmation that
 * `promoteExactBatch`'s atomic force-push already landed it. This predicate
 * is ONLY safe to trust for a PR whose atomic `git push --atomic ...
 * --force-with-lease` has already returned successfully -- it does not, on
 * its own, prove a promotion happened; it corroborates one that the caller
 * already knows (from the push's own success) took effect.
 *
 * GitHub's `merged`/`merged_at` PR fields are populated ONLY when a PR is
 * closed through GitHub's own merge machinery (the Merge Pull Request
 * REST/GraphQL API or the web "Merge" button). This promotion strategy
 * intentionally bypasses that machinery -- it force-pushes the exact
 * validated candidate SHA directly onto both `main` and every entry's own
 * head ref in one atomic multi-ref push, specifically to get true atomicity
 * across a multi-PR batch, which GitHub's own merge API cannot do. That
 * means `merged`/`merged_at` are NEVER set for a promotion done this way, no
 * matter how long you wait -- this was originally believed to be a lag
 * (ADR 0062 DEC-024) but was proven, live in production on 2026-07-15, to be
 * permanent: seven real promoted PRs across two separate batches, one over
 * nine hours old, still showed `merged: false, merged_at: null`, even though
 * `git log main --grep Merge-Train-PR` proved every one of their commits was
 * correctly present on `main`. What GitHub *does* reliably do -- observed
 * within ~20s of the push in all seven cases -- is auto-close the PR once
 * its head ref (now identical to `main`'s tip) shows no remaining diff
 * against the base branch. `state === 'closed'` is therefore the correct,
 * achievable, fast ground-truth completion signal for this promotion
 * mechanism; `merged === true` is kept only as a defensive OR-branch in case
 * some other/future promotion path ever does go through GitHub's own merge
 * API. See ADR 0062 DEC-025.
 */
export function isPostPushConfirmationSatisfied(prData) {
  return Boolean(prData) && (prData.merged === true || prData.state === 'closed');
}

/**
 * Create a `waitForMergedPr(entry, _finalCandidateSha)` confirmation poller bound to `request`
 * and `token`. Extracted here (rather than left inline in the untestable,
 * top-level `reconcile.mjs` CLI script) so the actual polling predicate --
 * previously only exercised in production via an injected fake in tests,
 * never for real -- gets direct unit test coverage with a fake `request`.
 */
export function createWaitForMergedPr({
  request,
  token,
  owner,
  repo,
  pollDelaysMs = [2000, 4000, 8000, 8000, 15000, 15000, 25000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  return async function waitForMergedPr(entry, _finalCandidateSha) {
    for (let attempt = 0; attempt <= pollDelaysMs.length; attempt += 1) {
      const current = (await request(token, `/repos/${owner}/${repo}/pulls/${entry.number}`)).data;
      if (isPostPushConfirmationSatisfied(current)) {
        return true;
      }
      if (attempt < pollDelaysMs.length) {
        await sleep(pollDelaysMs[attempt]);
      }
    }
    return false;
  };
}

/**
 * Create dispatch functions bound to `workflowDispatchToken` (GITHUB_TOKEN).
 * Both recovery and validation workflow dispatches must use the built-in
 * Actions token rather than the repository App promotion token; using the
 * App token causes 403 responses on workflow_dispatch endpoints. Binding the
 * token through this factory makes the routing unit-testable: a test can
 * verify that the returned functions always forward `workflowDispatchToken`
 * to the underlying helpers regardless of what other tokens are in scope.
 */
export function buildDispatchBindings({ request, workflowDispatchToken, owner, repo }) {
  async function dispatchRecovery(prNumber, trigger) {
    await dispatchRecoveryWorkflow({
      request,
      token: workflowDispatchToken,
      owner,
      repo,
      prNumber,
      trigger,
    });
  }
  async function dispatchValidation(sha, fingerprint, entries) {
    await dispatchValidationWorkflow({
      request,
      token: workflowDispatchToken,
      owner,
      repo,
      sha,
      fingerprint,
      entries,
    });
  }
  return { dispatchRecovery, dispatchValidation };
}
