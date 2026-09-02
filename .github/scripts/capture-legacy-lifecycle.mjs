import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listReviewThreads } from './ci-recovery/github.mjs';
import { effectiveLatestThreadComment, extractAddressedMarkerSha } from './ci-recovery/state.mjs';
import { MERGE_TRAIN_STATUS_MARKER } from './ci-recovery/markers.mjs';

const CI_DECISION_PREFIX = 'CI_RECOVERY_DECISION ';

function readLog(logPath) {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

export function parseCiRecoveryDecision(log) {
  const lines = String(log)
    .split(/\r?\n/)
    .filter((line) => line.startsWith(CI_DECISION_PREFIX));
  if (!lines.length) return null;
  return JSON.parse(lines.at(-1).slice(CI_DECISION_PREFIX.length));
}

function markerState(threads) {
  if (!threads.length) return 'none';
  return threads.every((thread) => thread.isResolved) ? 'resolved' : 'unresolved';
}

async function reachableMarkerShas({ github, owner, repo, threads, headSha }) {
  const markerShas = new Set();
  for (const thread of threads.filter((entry) => !entry.isResolved)) {
    const sha = extractAddressedMarkerSha(effectiveLatestThreadComment(thread)?.body);
    if (sha && !headSha.toLowerCase().startsWith(sha)) markerShas.add(sha);
  }

  const reachable = [];
  for (const sha of markerShas) {
    try {
      const comparison = await github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${sha}...${headSha}`,
      });
      if (comparison.data.status === 'identical' || comparison.data.status === 'ahead') {
        reachable.push(sha);
      }
    } catch {
      // The authoritative resolver treats an indeterminate marker SHA as unreachable.
    }
  }
  return reachable.sort();
}

async function pullSnapshot({ github, token, owner, repo, prNumber, headSha }) {
  const pull = (await github.rest.pulls.get({ owner, repo, pull_number: Number(prNumber) })).data;
  const review = await listReviewThreads(token, owner, repo, Number(prNumber));
  return {
    pull,
    reviewThreads: review.threads,
    reachableCommitShas: await reachableMarkerShas({
      github,
      owner,
      repo,
      threads: review.threads,
      headSha: headSha || pull.head.sha,
    }),
  };
}

function writeRecords(outputPath, records) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({ records }, null, 2)}\n`);
  return records.length;
}

export async function captureCiRecovery({
  github,
  token,
  owner,
  repo,
  prNumber,
  runId,
  trigger,
  outcome,
  logPath,
  outputPath,
}) {
  const decision = parseCiRecoveryDecision(readLog(logPath));
  if (!decision) return writeRecords(outputPath, []);
  const snapshot = await pullSnapshot({
    github,
    token,
    owner,
    repo,
    prNumber,
    headSha: decision.head,
  });
  const legacyAction = outcome === 'success' ? decision.action : `workflow-${outcome}`;
  return writeRecords(outputPath, [
    {
      workflowName: 'ci-recovery',
      runId: String(runId),
      prNumber: String(prNumber),
      trigger,
      headSha: decision.head || snapshot.pull.head.sha,
      reachableCommitShas: snapshot.reachableCommitShas,
      reviewThreads: snapshot.reviewThreads,
      lifecycle: { kind: 'ci-recovery', decision },
      legacyDecision: {
        workflowName: 'ci-recovery',
        prNumber: String(prNumber),
        trigger,
        verdict:
          outcome !== 'success' || Number(decision.blockerCount) > 0 ? 'risky' : 'recommended',
        action: legacyAction,
        markerState: markerState(snapshot.reviewThreads),
        mutates: false,
        noOp: true,
      },
    },
  ]);
}

function mergeTrainState(comments) {
  const matches = comments.filter((comment) =>
    String(comment.body).trimStart().startsWith(MERGE_TRAIN_STATUS_MARKER),
  );
  if (matches.length !== 1) return null;
  return String(matches[0].body).match(/^- State: `([^`]+)`$/m)?.[1] ?? null;
}

export async function captureMergeTrain({
  github,
  token,
  owner,
  repo,
  prNumbers,
  runId,
  trigger,
  outcome,
  outputPath,
}) {
  const records = [];
  for (const prNumber of [...new Set(prNumbers.map(Number))].filter(Number.isInteger)) {
    const [snapshot, comments] = await Promise.all([
      pullSnapshot({ github, token, owner, repo, prNumber }),
      github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      }),
    ]);
    const state = mergeTrainState(comments);
    if (!state) continue;
    const legacyAction = outcome === 'success' ? state : `workflow-${outcome}`;
    records.push({
      workflowName: 'merge-train',
      runId: String(runId),
      prNumber: String(prNumber),
      trigger,
      headSha: snapshot.pull.head.sha,
      reachableCommitShas: snapshot.reachableCommitShas,
      reviewThreads: snapshot.reviewThreads,
      lifecycle: { kind: 'merge-train', state },
      legacyDecision: {
        workflowName: 'merge-train',
        prNumber: String(prNumber),
        trigger,
        verdict:
          outcome !== 'success' || state === 'blocked' || state === 'failure'
            ? 'risky'
            : 'recommended',
        action: legacyAction,
        markerState: markerState(snapshot.reviewThreads),
        mutates: false,
        noOp: true,
      },
    });
  }
  return writeRecords(outputPath, records);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  throw new Error('capture-legacy-lifecycle.mjs is imported by trusted workflow steps');
}
