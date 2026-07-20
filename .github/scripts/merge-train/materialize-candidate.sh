#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_REF:?CANDIDATE_REF is required}"
: "${CANDIDATE_SHA:?CANDIDATE_SHA is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

if [[ "${CANDIDATE_REF}" != refs/merge-train-candidates/* ]]; then
  echo "Candidate transport ref must use refs/merge-train-candidates/**" >&2
  exit 1
fi
if [[ ! "${CANDIDATE_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Candidate SHA must be a 40-character Git SHA" >&2
  exit 1
fi

transport_ref='refs/merge-train-transport/candidate'
candidate_ref='refs/merge-train-validation/candidate'
bundle_path="${RUNNER_TEMP:?RUNNER_TEMP is required}/merge-train-candidate.bundle"
authorization="$(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 | tr -d '\r\n')"
unset GITHUB_TOKEN

GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' \
  GIT_CONFIG_VALUE_0='' \
  GIT_CONFIG_KEY_1='http.https://github.com/.extraheader' \
  GIT_CONFIG_VALUE_1="AUTHORIZATION: basic ${authorization}" \
  GIT_TERMINAL_PROMPT=0 \
  git fetch origin "${CANDIDATE_REF}:${transport_ref}" --force
unset authorization

if [[ "$(git cat-file -t "${transport_ref}")" != 'blob' ]]; then
  echo "Candidate transport ref must resolve to a Git blob" >&2
  exit 1
fi

git cat-file blob "${transport_ref}" > "${bundle_path}"
git bundle verify "${bundle_path}"
git fetch "${bundle_path}" "HEAD:${candidate_ref}" --force

materialized_sha="$(git rev-parse "${candidate_ref}")"
if [[ "${materialized_sha}" != "${CANDIDATE_SHA}" ]]; then
  echo "Candidate bundle SHA mismatch" >&2
  exit 1
fi

git checkout --detach "${CANDIDATE_SHA}"
git clean -ffdqx
