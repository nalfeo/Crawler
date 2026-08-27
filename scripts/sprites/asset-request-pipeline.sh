#!/usr/bin/env bash

set -uo pipefail
# Enable monitor mode so the backgrounded worker becomes the leader of its own
# process group. `sprites:worker` is an npm -> tsx -> node tree, so signalling
# only the launcher PID can leave the real worker consuming the queue; cleanup
# signals the whole group (negative PID) instead.
set -m

npm_bin="${SPRITES_PIPELINE_NPM_BIN:-npm}"
marker_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
marker="${SPRITES_WORKER_PRODUCER_COMPLETE_FILE:-${marker_root}/asset-request-producer-complete-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-$$}}"
worker_pid=""
worker_reaped=0

# Signals the worker's entire process group, then escalates to SIGKILL so no
# descendant (tsx/node) can outlive a dead launcher. `worker_pid` is never
# cleared once set: after the launcher is reaped its PGID is still the handle
# for any surviving descendants.
stop_worker_group() {
  [[ -n "$worker_pid" ]] || return 0
  kill -TERM -- -"$worker_pid" 2>/dev/null || kill -TERM "$worker_pid" 2>/dev/null || true
  if [[ "$worker_reaped" -eq 0 ]]; then
    wait "$worker_pid" 2>/dev/null || true
    worker_reaped=1
  fi
  kill -KILL -- -"$worker_pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_worker_group
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
  worker_reaped=1
  stop_worker_group
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
worker_reaped=1
stop_worker_group
rm -f "$marker"
trap - EXIT INT TERM
exit "$worker_status"
