#!/usr/bin/env bash
# reply-and-resolve-thread — reply to a PR review comment, then resolve its thread.
#
# Usage:
#   bash reply-and-resolve-thread.sh <owner> <repo> <pr_number> <thread_id> <comment_database_id> <reply_markdown_file>

set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "Usage: $0 <owner> <repo> <pr_number> <thread_id> <comment_database_id> <reply_markdown_file>" >&2
  exit 2
fi

OWNER="$1"
REPO="$2"
PR_NUMBER="$3"
THREAD_ID="$4"
COMMENT_DATABASE_ID="$5"
REPLY_MARKDOWN_FILE="$6"
FULL_REPO="${OWNER}/${REPO}"

export GH_PAGER=""

if [[ ! -f "$REPLY_MARKDOWN_FILE" ]]; then
  echo "Reply markdown file not found: $REPLY_MARKDOWN_FILE" >&2
  exit 2
fi

reply_root="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
reply_json="$(mktemp "$reply_root/agent-merge-reply.XXXXXX")"
cleanup() {
  rm -f "$reply_json"
}
trap cleanup EXIT

jq -Rs '{body: .}' < "$REPLY_MARKDOWN_FILE" > "$reply_json"

gh api -X POST "/repos/${FULL_REPO}/pulls/${PR_NUMBER}/comments/${COMMENT_DATABASE_ID}/replies" --input "$reply_json" >/dev/null
gh api graphql -f query='mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id } } }' -F threadId="$THREAD_ID" >/dev/null

echo "Replied to comment ${COMMENT_DATABASE_ID} and resolved thread ${THREAD_ID}."
