#!/usr/bin/env bash
# check-merge-conditions — deterministic merge-condition check for agent-merge skill.
#
# Usage: bash check-merge-conditions.sh <owner> <repo> <pr_number>
#
# Outputs a structured report of all three merge conditions:
#   Reviews   — Review threads handled  (no unresolved review threads)
#   Checks    — CI green                (all checks passed)
#   Mergeable — No conflicts            (mergeable, branch not behind)
#
# Exit codes:
#   0 — all deterministic/actionable conditions satisfied; inspect final GitHub merge signal
#   1 — one or more deterministic/actionable conditions unsatisfied (details in output)
#   2 — usage error or API failure

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <owner> <repo> <pr_number>" >&2
  exit 2
fi

OWNER="$1"
REPO="$2"
PR_NUMBER="$3"
FULL_REPO="${OWNER}/${REPO}"

export GH_PAGER=""

# ── Helpers ──────────────────────────────────────────────────────────────────

fail() { echo "ERROR: $*" >&2; exit 2; }

append_detail() {
  local addition="$1"
  local detail_name="$2"
  if [[ -z "$addition" ]]; then
    return
  fi

  local current_detail="${!detail_name}"
  if [[ -n "$current_detail" ]]; then
    printf -v "$detail_name" "%s\n%s" "$current_detail" "$addition"
  else
    printf -v "$detail_name" "%s" "$addition"
  fi
}

CCR_CHECK_RUN_NAME="copilot-pull-request-reviewer"
# CCR usually starts within seconds, so only give a brand-new head a short
# window before treating Cloud Code Review as not applicable.
CCR_GRACE_SECONDS="${CCR_GRACE_SECONDS:-60}"

STATE_DIR=$(git rev-parse --git-path agent-merge-state 2>/dev/null || true)
if [[ -z "$STATE_DIR" ]]; then
  STATE_DIR="${TMPDIR:-/tmp}/copilot-agent-merge-state"
fi
mkdir -p "$STATE_DIR" || fail "Failed to prepare agent-merge state directory"

load_or_init_head_first_seen() {
  local state_file="$1"
  local current_head_sha="$2"
  local now_epoch="$3"
  local tracked_head_sha=""
  local tracked_first_seen=""

  if [[ -f "$state_file" ]]; then
    read -r tracked_head_sha tracked_first_seen <"$state_file" || true
  fi

  if [[ "$tracked_head_sha" != "$current_head_sha" ]] || [[ ! "$tracked_first_seen" =~ ^[0-9]+$ ]]; then
    tracked_first_seen="$now_epoch"
    printf "%s %s\n" "$current_head_sha" "$tracked_first_seen" >"$state_file"
  fi

  printf "%s\n" "$tracked_first_seen"
}

# ── Reviews: Review comments ────────────────────────────────────────────────

review_threads_query='
query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          isResolved
          id
          path
          line
          comments(first: 10) {
            nodes {
              body
              author { login }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}'

all_review_threads_json='[]'
next_cursor=''

while :; do
  if [[ -n "$next_cursor" ]]; then
    review_threads_page=$(gh api graphql \
      -f query="$review_threads_query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F number="$PR_NUMBER" \
      -F after="$next_cursor" 2>/dev/null) \
      || fail "Failed to fetch review threads"
  else
    review_threads_page=$(gh api graphql \
      -f query="$review_threads_query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F number="$PR_NUMBER" 2>/dev/null) \
      || fail "Failed to fetch review threads"
  fi

  page_nodes_json=$(echo "$review_threads_page" | jq '.data.repository.pullRequest.reviewThreads.nodes')
  all_review_threads_json=$(jq -cn \
    --argjson acc "$all_review_threads_json" \
    --argjson page "$page_nodes_json" \
    '$acc + $page')

  has_next_page=$(echo "$review_threads_page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
  next_cursor=$(echo "$review_threads_page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // ""')

  [[ "$has_next_page" == "true" ]] || break
done

unresolved_threads_json=$(echo "$all_review_threads_json" | jq '[.[] | select(.isResolved == false)]')
unresolved_count=$(echo "$unresolved_threads_json" | jq 'length')

c1_ok=true
c1_detail=""
if [[ "$unresolved_count" -gt 0 ]]; then
  c1_ok=false
fi

if [[ "$unresolved_count" -gt 0 ]]; then
  unresolved_thread_detail=$(echo "$unresolved_threads_json" | jq -r '.[] | "  - \(.path):\(.line) [\(.id)] — \(.comments.nodes[0].author.login): \(.comments.nodes[0].body | split("\n")[0] | .[0:120])"')
  c1_detail=$(printf "  Unresolved review threads:\n%s" "$unresolved_thread_detail")
fi

# ── Shared PR state ──────────────────────────────────────────────────────────

pr_json=$(GH_PAGER="" gh pr view "$PR_NUMBER" --repo "$FULL_REPO" \
  --json mergeable,mergeStateStatus,state,isDraft,reviewDecision,headRefOid 2>/dev/null) \
  || fail "Failed to fetch PR status"

mergeable=$(echo "$pr_json" | jq -r '.mergeable')
merge_state=$(echo "$pr_json" | jq -r '.mergeStateStatus')
pr_state=$(echo "$pr_json" | jq -r '.state')
is_draft=$(echo "$pr_json" | jq -r '.isDraft')
review_decision=$(echo "$pr_json" | jq -r '.reviewDecision')
head_sha=$(echo "$pr_json" | jq -r '.headRefOid // ""')

[[ -n "$head_sha" ]] || fail "Failed to determine PR head SHA"

# ── Checks: CI status ───────────────────────────────────────────────────────

checks_json=$(GH_PAGER="" gh pr view "$PR_NUMBER" --repo "$FULL_REPO" \
  --json statusCheckRollup 2>/dev/null) \
  || fail "Failed to fetch CI status"

c2_ok=true
c2_status="pass"
c2_detail=""
c2_summary="all checks passed"
failed_count=0
pending_count=0

checks_count=$(echo "$checks_json" | jq '.statusCheckRollup | length')

if [[ "$checks_count" -gt 0 ]]; then
  failed_count=$(echo "$checks_json" | jq '
    [
      .statusCheckRollup[]?
      | ((.status // "") | ascii_upcase) as $status
      | ((.conclusion // .state // "UNKNOWN") | ascii_upcase) as $result
      | select(
          $result == "FAILURE"
          or $result == "FAILED"
          or $result == "ERROR"
          or $result == "CANCELLED"
          or $result == "TIMED_OUT"
          or $result == "ACTION_REQUIRED"
          or $result == "STARTUP_FAILURE"
          or $result == "STALE"
        )
    ] | length')

  pending_count=$(echo "$checks_json" | jq '
    [
      .statusCheckRollup[]?
      | ((.status // "") | ascii_upcase) as $status
      | ((.conclusion // .state // "") | ascii_upcase) as $result
      | select(
          $result == "PENDING"
          or $result == "QUEUED"
          or $result == "IN_PROGRESS"
          or $result == "WAITING"
          or $result == "REQUESTED"
          or ($status != "" and $status != "COMPLETED" and $result == "")
        )
    ] | length')

  if [[ "$failed_count" -gt 0 ]]; then
    c2_ok=false
    c2_status="fail"
    failed_check_detail=$(echo "$checks_json" | jq -r '
      .statusCheckRollup[]?
      | ((.conclusion // .state // "UNKNOWN") | ascii_upcase) as $result
      | select(
          $result == "FAILURE"
          or $result == "FAILED"
          or $result == "ERROR"
          or $result == "CANCELLED"
          or $result == "TIMED_OUT"
          or $result == "ACTION_REQUIRED"
          or $result == "STARTUP_FAILURE"
          or $result == "STALE"
        )
      | "  - \((.name // .context // "unknown")) — \(.conclusion // .state // "UNKNOWN")"')
    append_detail "  Failed checks:" c2_detail
    append_detail "$failed_check_detail" c2_detail
  elif [[ "$pending_count" -gt 0 ]]; then
    c2_ok=false
    c2_status="pending"
    append_detail "  Some checks are still running." c2_detail
  fi
fi

# Cloud Code Review can appear as an unlisted check run that does not show up
# in statusCheckRollup, so inspect raw head-SHA check-runs directly.
ccr_check_runs_json=$(gh api --paginate "/repos/${FULL_REPO}/commits/${head_sha}/check-runs?per_page=100&filter=latest" 2>/dev/null \
  | jq -s '{check_runs: (map(.check_runs // []) | add)}') \
  || fail "Failed to fetch raw check-runs for PR head"
ccr_reviews_json=$(gh api --paginate "/repos/${FULL_REPO}/pulls/${PR_NUMBER}/reviews?per_page=100" 2>/dev/null \
  | jq -s 'add') \
  || fail "Failed to fetch PR reviews"
requested_reviewers_json=$(gh api "/repos/${FULL_REPO}/pulls/${PR_NUMBER}/requested_reviewers" 2>/dev/null) \
  || fail "Failed to fetch requested reviewers"

current_ccr_check_json=$(echo "$ccr_check_runs_json" | jq -c --arg name "$CCR_CHECK_RUN_NAME" '
  [.check_runs[]?
    | select(((.name // "") | ascii_downcase) == ($name | ascii_downcase))
  ]
  | sort_by(.completed_at // "", .started_at // "", (.id // 0))
  | last // empty')
current_head_ccr_review_json=$(echo "$ccr_reviews_json" | jq -c --arg author "$CCR_CHECK_RUN_NAME" --arg head "$head_sha" '
  [ .[] | select(
      ((.user.login // "") | ascii_downcase) == ($author | ascii_downcase)
      and (.commit_id // "") == $head
    )
  ] | sort_by(.submitted_at // "", (.id // 0)) | last // empty')
any_ccr_review_count=$(echo "$ccr_reviews_json" | jq --arg author "$CCR_CHECK_RUN_NAME" '
  [ .[] | select(((.user.login // "") | ascii_downcase) == ($author | ascii_downcase)) ] | length')
ccr_review_requested_count=$(echo "$requested_reviewers_json" | jq --arg author "$CCR_CHECK_RUN_NAME" '
  [ .users[]? | select(((.login // "") | ascii_downcase) == ($author | ascii_downcase)) ] | length')

ccr_review_requested=false
if [[ "$ccr_review_requested_count" -gt 0 ]]; then
  ccr_review_requested=true
fi

ccr_status="optional"

head_state_file="${STATE_DIR}/${OWNER}__${REPO}__${PR_NUMBER}.head"
now_epoch=$(date +%s)
head_first_seen_epoch=$(load_or_init_head_first_seen "$head_state_file" "$head_sha" "$now_epoch")
head_age_seconds=$((now_epoch - head_first_seen_epoch))

if [[ -n "$current_ccr_check_json" ]]; then
  ccr_check_status=$(echo "$current_ccr_check_json" | jq -r '.status // ""')
  ccr_check_conclusion=$(echo "$current_ccr_check_json" | jq -r '.conclusion // ""')
  ccr_check_completed_at=$(echo "$current_ccr_check_json" | jq -r '.completed_at // ""')

  if [[ -n "$current_head_ccr_review_json" ]]; then
    ccr_review_state=$(echo "$current_head_ccr_review_json" | jq -r '.state // ""')
    ccr_review_submitted_at=$(echo "$current_head_ccr_review_json" | jq -r '.submitted_at // ""')
  else
    ccr_review_state=""
    ccr_review_submitted_at=""
  fi

  ccr_check_status_upper=$(printf "%s" "$ccr_check_status" | tr '[:lower:]' '[:upper:]')

  if [[ "$ccr_check_status_upper" != "COMPLETED" ]]; then
    ccr_status="pending"
    append_detail "  Cloud Code Review is still ${ccr_check_status} for the current head ${head_sha:0:12}." c2_detail
  elif [[ "$ccr_check_conclusion" =~ ^(success|neutral|skipped)$ ]]; then
    ccr_status="pass"
    append_detail "  Cloud Code Review completed via raw check-run." c2_detail
  elif [[ -n "$ccr_review_submitted_at" ]] \
    && [[ "$ccr_review_state" =~ ^(APPROVED|COMMENTED)$ ]] \
    && [[ -n "$ccr_check_completed_at" ]] \
    && [[ "$ccr_review_submitted_at" > "$ccr_check_completed_at" ]]; then
    ccr_status="pass"
    append_detail "  Cloud Code Review review was submitted after the latest raw check-run completed; treating the current head as reviewed." c2_detail
  else
    if $ccr_review_requested; then
      ccr_status="fail"
      append_detail "  Cloud Code Review concluded with ${ccr_check_conclusion:-UNKNOWN} for ${head_sha:0:12}." c2_detail
    else
      append_detail "  Cloud Code Review concluded with ${ccr_check_conclusion:-UNKNOWN} for ${head_sha:0:12}, but no review request is active on this PR; not blocking merge." c2_detail
    fi
  fi
elif [[ -n "$current_head_ccr_review_json" ]]; then
  ccr_review_state=$(echo "$current_head_ccr_review_json" | jq -r '.state // ""')
  if [[ "$ccr_review_state" =~ ^(APPROVED|COMMENTED)$ ]]; then
    ccr_status="pass"
    append_detail "  Cloud Code Review completed via Copilot review on the current head." c2_detail
  else
    if $ccr_review_requested; then
      ccr_status="pending"
      append_detail "  Cloud Code Review review state is ${ccr_review_state:-UNKNOWN} for the current head." c2_detail
    else
      append_detail "  Cloud Code Review review state is ${ccr_review_state:-UNKNOWN} for the current head, but no review request is active on this PR; not blocking merge." c2_detail
    fi
  fi
elif $ccr_review_requested && (( head_age_seconds < CCR_GRACE_SECONDS )); then
  ccr_status="pending"
  if [[ "$any_ccr_review_count" -gt 0 ]]; then
    append_detail "  Cloud Code Review was requested on this PR; prior Copilot review activity exists on this PR, and a fresh signal is still pending for the current head." c2_detail
  else
    append_detail "  Cloud Code Review was requested on this PR, but no signal is visible yet for the current head; waiting up to ${CCR_GRACE_SECONDS}s before treating it as non-blocking." c2_detail
  fi
elif $ccr_review_requested; then
  append_detail "  No Cloud Code Review signal appeared for the current head after ${CCR_GRACE_SECONDS}s even though a review request is visible on this PR; treating it as non-blocking for now." c2_detail
fi

if [[ "$ccr_status" == "fail" ]]; then
  c2_ok=false
  c2_status="fail"
elif [[ "$ccr_status" == "pending" ]]; then
  c2_ok=false
  if [[ "$c2_status" != "fail" ]]; then
    c2_status="pending"
  fi
fi

if $c2_ok; then
  if [[ "$ccr_status" == "optional" ]]; then
    c2_summary="all checks passed; Cloud Code Review is not blocking this head"
  else
    c2_summary="all checks passed; Cloud Code Review completed for current head"
  fi
fi

# ── Mergeable: Conflicts & branch status ────────────────────────────────────

c3_ok=true
c3_detail=""
if [[ "$pr_state" != "OPEN" ]]; then
  c3_ok=false
  c3_detail="Pull request state is ${pr_state}, not OPEN."
elif [[ "$is_draft" == "true" ]]; then
  c3_ok=false
  c3_detail="Pull request is still a draft."
elif [[ "$mergeable" == "CONFLICTING" ]]; then
  c3_ok=false
  c3_detail="Branch has merge conflicts."
elif [[ "$mergeable" != "MERGEABLE" ]]; then
  c3_ok=false
  c3_detail="Mergeability is ${mergeable}; GitHub has not reported the branch as mergeable yet."
elif [[ "$merge_state" == "BEHIND" ]]; then
  c3_ok=false
  c3_detail="Branch is behind base (repo requires up-to-date branch)."
fi

# ── Final GitHub merge signal (authoritative for whether to try gh pr merge;
#    still reported separately from Reviews/Checks/Mergeable) ─────────────────

final_merge_signal_ready=false
final_merge_signal_detail=""

if [[ "$merge_state" == "CLEAN" ]]; then
  final_merge_signal_ready=true
  final_merge_signal_detail="GitHub currently allows merge (mergeStateStatus: CLEAN). Treat reviewDecision as informational here and attempt gh pr merge."
elif [[ "$review_decision" == "REVIEW_REQUIRED" ]]; then
  final_merge_signal_detail="GitHub still requires human review approval before merge."
elif [[ "$review_decision" == "CHANGES_REQUESTED" ]]; then
  final_merge_signal_detail="GitHub review decision is CHANGES_REQUESTED."
elif [[ "$merge_state" == "BLOCKED" ]]; then
  final_merge_signal_detail="GitHub still reports a non-code merge signal blocking merge (for example required approval)."
else
  final_merge_signal_detail="GitHub merge signal is ${merge_state}; verify before merging."
fi

# ── Report ───────────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════"
echo " MERGE CONDITIONS — ${FULL_REPO}#${PR_NUMBER}"
echo "═══════════════════════════════════════════"
echo ""
echo "PR state: ${pr_state}  draft: ${is_draft}"
if $final_merge_signal_ready; then
  echo "GitHub merge signal: ALLOWED (mergeStateStatus: ${merge_state})"
  echo "reviewDecision: ${review_decision}  [informational only when mergeStateStatus is CLEAN]"
else
  echo "GitHub merge signal: NOT ALLOWED YET (mergeStateStatus: ${merge_state})"
  echo "reviewDecision: ${review_decision}"
fi
echo "mergeable: ${mergeable}"
echo ""

if $c1_ok; then
  echo "✅ Reviews — handled (0 unresolved review threads)"
else
  echo "❌ Reviews — NOT handled (${unresolved_count} unresolved review threads)"
  printf "%s\n" "$c1_detail"
fi

echo ""

if $c2_ok; then
  echo "✅ Checks — passing (${c2_summary})"
else
  if [[ "$c2_status" == "pending" ]]; then
    if [[ "$pending_count" -eq 0 && "$ccr_status" == "pending" ]]; then
      echo "⏳ Checks — Cloud Code Review pending"
    else
      echo "⏳ Checks — pending (checks still running)"
    fi
  else
    if [[ "$failed_count" -eq 0 && "$ccr_status" == "fail" ]]; then
      echo "❌ Checks — requested Cloud Code Review failing"
    else
      echo "❌ Checks — failing"
    fi
  fi
fi
if [[ -n "$c2_detail" ]]; then
  printf "%s\n" "$c2_detail"
fi

echo ""

if $c3_ok; then
  echo "✅ Mergeable — clean (mergeable: ${mergeable}, status: ${merge_state})"
else
  echo "❌ Mergeable — ${c3_detail}"
fi

echo ""
echo "───────────────────────────────────────────"

all_ok=true
if ! $c1_ok || ! $c2_ok || ! $c3_ok; then
  all_ok=false
fi

if $all_ok; then
  if $final_merge_signal_ready; then
    echo "🟢 ALL ACTIONABLE CONDITIONS MET — GitHub currently allows merge"
    echo "  ${final_merge_signal_detail}"
  else
    echo "🟡 ALL ACTIONABLE CONDITIONS MET — not yet mergeable"
    echo "  ${final_merge_signal_detail}"
  fi
  exit 0
else
  echo "🔴 NOT READY — see above for unsatisfied conditions"
  exit 1
fi
