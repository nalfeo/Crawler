import { createHash } from 'node:crypto';

import { proofFingerprint } from './state.mjs';

const SYNTHETIC_IDENTITY = {
  GIT_AUTHOR_NAME: 'crawler-ci-conflict-coordinator[bot]',
  GIT_AUTHOR_EMAIL: 'crawler-ci-conflict-coordinator[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'crawler-ci-conflict-coordinator[bot]',
  GIT_COMMITTER_EMAIL: 'crawler-ci-conflict-coordinator[bot]@users.noreply.github.com',
};

function syntheticTimestamp(entry) {
  const digest = createHash('sha256').update(`${entry.number}\0${entry.headSha}`).digest();
  return `@${1735689600 + (digest.readUInt32BE(0) % 31536000)}`;
}

function stagedChangesExist(git) {
  try {
    git(['diff', '--cached', '--quiet']);
    return false;
  } catch {
    return true;
  }
}

function resetSyntheticTree(git, sha) {
  git(['reset', '--hard', sha]);
}

export function buildSupersessionProofs({ baseSha, entries, git }) {
  git(['checkout', '--detach', baseSha]);
  let syntheticHead = baseSha;
  const applied = [];
  const proofs = [];

  for (const entry of entries) {
    let status = 'applied';
    let reason = null;
    try {
      git(['merge', '--squash', '--no-commit', entry.ref], {
        env: SYNTHETIC_IDENTITY,
      });
      if (!stagedChangesExist(git)) {
        status = 'superseded';
        resetSyntheticTree(git, syntheticHead);
      } else {
        const timestamp = syntheticTimestamp(entry);
        git(['commit', '-m', `ci-conflict proof for PR #${entry.number}`], {
          env: {
            ...SYNTHETIC_IDENTITY,
            GIT_AUTHOR_DATE: timestamp,
            GIT_COMMITTER_DATE: timestamp,
          },
        });
        syntheticHead = git(['rev-parse', 'HEAD']);
      }
    } catch (error) {
      status = 'ambiguous';
      let conflict = false;
      try {
        conflict = git(['ls-files', '--unmerged']).trim().length > 0;
      } catch {
        conflict = false;
      }
      reason = conflict
        ? 'full-tree synthetic squash conflicts with the ordered predecessor state'
        : `could not produce deterministic supersession proof: ${error.message}`;
      resetSyntheticTree(git, syntheticHead);
    }

    const predecessorHeads = applied.map(({ number, headSha }) => ({ number, headSha }));
    const proof = {
      number: entry.number,
      status,
      representedBy: predecessorHeads.map(({ number }) => number),
      predecessorHeads,
      baseSha,
      targetHead: entry.headSha,
      fingerprint: proofFingerprint({
        baseSha,
        predecessorHeads,
        targetHead: entry.headSha,
      }),
      ...(reason ? { reason } : {}),
    };
    proofs.push(proof);
    if (status === 'applied') applied.push(entry);
  }

  return proofs;
}

export function bindProofToLeader(proof, leader) {
  const leaderHead =
    leader && leader.number !== proof.number
      ? { number: leader.number, headSha: leader.headSha }
      : null;
  return {
    ...proof,
    leaderHead,
    fingerprint: proofFingerprint({
      baseSha: proof.baseSha,
      predecessorHeads: proof.predecessorHeads,
      targetHead: proof.targetHead,
      leaderHead,
    }),
  };
}

export function duplicateProofStillMatches({ proof, mainSha, livePulls, repository }) {
  if (proof.status !== 'superseded' || proof.baseSha !== mainSha) return false;
  const expected = [
    ...proof.predecessorHeads,
    ...(proof.leaderHead ? [proof.leaderHead] : []),
    { number: proof.number, headSha: proof.targetHead },
  ];
  const seen = new Set();
  for (const item of expected) {
    if (seen.has(item.number)) continue;
    seen.add(item.number);
    const pull = livePulls.get(item.number);
    if (
      !pull ||
      pull.state !== 'open' ||
      pull.draft ||
      pull.base?.ref !== 'main' ||
      pull.head?.sha !== item.headSha ||
      pull.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()
    ) {
      return false;
    }
  }
  return (
    proof.fingerprint ===
    proofFingerprint({
      baseSha: proof.baseSha,
      predecessorHeads: proof.predecessorHeads,
      targetHead: proof.targetHead,
      leaderHead: proof.leaderHead,
    })
  );
}
