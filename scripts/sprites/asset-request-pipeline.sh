#!/usr/bin/env bash

set -uo pipefail

npm_bin="${SPRITES_PIPELINE_NPM_BIN:-npm}"
marker_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
marker="${SPRITES_WORKER_PRODUCER_COMPLETE_FILE:-${marker_root}/asset-request-producer-complete-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-$$}}"
worker_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill -TERM "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$marker"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$(dirname "$marker")"
rm -f "$marker"
if [[ -e "$marker" ]]; then
  echo "asset-request pipeline: could not clear stale producer marker: $marker" >&2
  echo "Remediation: remove the marker and rerun the workflow." >&2
  exit 1
fi

SPRITES_WORKER_PRODUCER_COMPLETE_FILE="$marker" "$npm_bin" run sprites:worker &
worker_pid=$!

# Provider credentials stay out of the ingestion child. The ingester needs only
# GitHub and Azure Storage access; generation starts independently in the worker.
env \
  -u AZURE_OPENAI_ENDPOINT \
  -u AZURE_OPENAI_API_KEY \
  -u AZURE_OPENAI_API_VERSION \
  -u AZURE_OPENAI_IMAGE_DEPLOYMENT \
  -u AZURE_OPENAI_CHAT_DEPLOYMENT \
  -u AZURE_OPENAI_VISION_DEPLOYMENT \
  -u AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT \
  "$npm_bin" run sprites:ingest-once
producer_status=$?
if [[ "$producer_status" -ne 0 ]]; then
  echo "asset-request pipeline: ingestion failed with exit code $producer_status; stopping worker" >&2
  exit "$producer_status"
fi

if ! kill -0 "$worker_pid" 2>/dev/null; then
  wait "$worker_pid"
  worker_status=$?
  worker_pid=""
  if [[ "$worker_status" -eq 0 ]]; then
    echo "asset-request pipeline: worker exited before producer completion" >&2
    echo "Remediation: inspect the worker log and rerun the workflow." >&2
    exit 1
  fi
  exit "$worker_status"
fi

# pollOnce returns only after every queue enqueue and ingest-state save has
# completed. File creation is the durable handoff: all earlier empty polls are
# ignored, and the worker confirms emptiness with a dequeue begun after this
# marker before exiting. Requests submitted after this producer boundary belong
# to the next serialized workflow run.
: > "$marker" || {
  echo "asset-request pipeline: could not write producer marker: $marker" >&2
  echo "Remediation: verify RUNNER_TEMP is writable and rerun the workflow." >&2
  exit 1
}

wait "$worker_pid"
worker_status=$?
worker_pid=""
rm -f "$marker"
trap - EXIT INT TERM
exit "$worker_status"
