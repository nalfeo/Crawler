#!/usr/bin/env bash
# The durable, trusted, run+attempt-scoped lease that decides who owns a
# Goobers recovery reservation.
#
# Why this exists
# ---------------
# `goobers-run.yml` reserves at most one recovery target per dispatch with
# `goobers/status:in-review` and then resumes it in lane 1 slot 1. That path
# deliberately BYPASSES Goobers' provider-side claim protocol (the query-backlog
# recovery branch of `.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml`
# just labels the issue), so the reservation label plus this lease are the only
# things standing between a resuming slot and a second agent.
#
# The lease has to survive the Actions run that created it. An Actions run can
# report `completed` while a Setsid-detached stage descendant is still pushing
# commits -- that is precisely the state `goobers-stage-teardown.sh` refuses to
# call clean, and precisely the state in which the adopting lane leaves its
# receipt ADOPTED BUT UNDISPOSED. So "is this issue free?" cannot be answered by
# looking at run status, at the label alone, or at this dispatch's own receipt:
# it has to be answered by reading the latest lease receipt of ANY dispatch and
# refusing while it is undisposed.
#
# Two properties make that answer trustworthy rather than merely convenient:
#
#   1. TRUSTED AUTHOR. Issue comments are public and the marker text is
#      predictable, so `contains(<marker>)` over every comment lets any account
#      that can comment forge a lease state -- a fake disposal receipt would
#      hand a live issue to a second agent, and a fake adoption receipt would
#      wedge recovery. Every receipt is therefore matched only on comments
#      written by the GitHub Actions identity: `user.type == "Bot"` plus, when
#      the API exposes the app association, `performed_via_github_app.slug ==
#      "github-actions"`, falling back to the exact `github-actions[bot]` login
#      when it does not. That login is unforgeable -- `[` and `]` are not legal
#      in a GitHub username, so no human account can hold it.
#
#   2. EXACT MARKER PARSING. A receipt is recognised only when a WHOLE LINE of
#      the comment body matches the anchored marker grammar
#
#        <!-- crawler-goobers-reservation-{adopted,disposed}:v1 \
#             run-id=<digits> attempt=<digits> issue=<digits> -->
#
#      Substring matching would let a quoted marker inside prose, a code fence,
#      or a longer line be read as a receipt.
#
#   3. SAME-COMMENT DISPOSAL. A disposal closes the latest adoption only when it
#      lives in THAT ADOPTION'S OWN COMMENT BODY. Trusted authorship is not by
#      itself enough, because this workflow posts other Actions-authored
#      comments on the same issue whose bodies contain FREE-FORM TEXT taken from
#      a Goobers run journal -- and journal text is written by the agent under
#      test, not by this workflow. A journal message that carried a newline plus
#      a well-formed disposal marker would render as a standalone marker line in
#      an Actions-authored result comment, and a disposal accepted from ANY
#      trusted comment would then close a live lease and hand the issue to a
#      second agent. Binding the disposal to the adoption's own comment makes
#      that impossible: the only writer that can append to a receipt comment is
#      the job that holds the receipt id, and it PATCHes it only after proving a
#      clean reap and disposition. (`goobers-run.yml` also collapses newlines out
#      of journal-derived text before rendering it, so the injected line cannot
#      be produced in the first place; this is the half that does not depend on
#      every future comment writer remembering to do that.)
#
# The lease key is `run-id` AND `attempt`, not `run-id` alone: re-running a
# failed Actions run keeps the same run id, and a re-run's adoption must be a
# NEW lease rather than something the previous attempt's disposal already
# closed.
#
# Usage (source it, then call):
#   . scripts/agent/goobers-reservation-lease.sh
#   goobers_lease_fetch  <repo> <issue> <out.json>      # fail-closed gh read
#   goobers_lease_state  <out.json> <issue>             # state\trun\tattempt\tid
#   goobers_lease_marker adopted|disposed <run> <attempt> <issue>
#
# `goobers_lease_state` prints one TAB-separated record:
#   none<TAB><TAB><TAB>              no trusted adoption receipt exists
#   adopted<TAB>run<TAB>attempt<TAB>id   latest trusted adoption is UNDISPOSED
#   disposed<TAB>run<TAB>attempt<TAB>id  latest trusted adoption was disposed
# and returns non-zero without printing when the comment payload cannot be
# parsed -- callers must treat that as "refuse", never as "free".
#
# The `id` field is the comment that carries the latest adoption receipt, which
# is also the ONLY comment a disposal for that lease may be written into. Both
# writers in `goobers-run.yml` -- the adoption's idempotency check and the
# disposal PATCH -- resolve their comment through this one function, so the
# comment a disposal is written to is by construction the comment the reader
# will later read the disposal from.
#
# Deliberately no top-level `set`: this file is sourced into workflow steps that
# choose their own shell options, and a library must not change its caller's.

# The identity that writes every receipt. `goobers-run.yml` posts them with
# `GH_TOKEN: ${{ github.token }}`, i.e. the GitHub Actions app installation
# token, which authors comments as `github-actions[bot]`. Overridable only so a
# fork running this workflow under a different app can state its own identity;
# widening it is a trust decision, not a configuration one.
GOOBERS_LEASE_TRUSTED_LOGIN="${GOOBERS_LEASE_TRUSTED_LOGIN:-github-actions[bot]}"
GOOBERS_LEASE_TRUSTED_APP_SLUG="${GOOBERS_LEASE_TRUSTED_APP_SLUG:-github-actions}"

# Shared jq definitions. Kept in one string so the trust rule and the marker
# grammar cannot drift between the state read and the receipt lookup.
#
# `trusted` prefers the app association when the API supplies one, because that
# is the strongest available statement of "the GitHub Actions app wrote this",
# and falls back to the exact bot login when `performed_via_github_app` is null.
# A comment with an app association that is NOT this app is untrusted even if
# the login somehow matched.
#
# `receipts` splits the body into lines, trims CR and surrounding blanks, keeps
# only whole lines that match the anchored grammar, and returns them parsed.
GOOBERS_LEASE_JQ_PRELUDE='
def trusted:
  ((.user.type // "") == "Bot")
  and (
    if (.performed_via_github_app // null) == null
    then ((.user.login // "") == $login)
    else ((.performed_via_github_app.slug // "") == $slug)
    end
  );
def marker_lines:
  (.body // "")
  | split("\n")
  | map(sub("\r$"; ""))
  | map(sub("^[ \t]+"; ""))
  | map(sub("[ \t]+$"; ""));
def receipts:
  marker_lines
  | map(select(test("^<!-- crawler-goobers-reservation-(adopted|disposed):v1 run-id=[0-9]+ attempt=[0-9]+ issue=[0-9]+ -->$")))
  | map(capture("^<!-- crawler-goobers-reservation-(?<kind>adopted|disposed):v1 run-id=(?<run>[0-9]+) attempt=(?<attempt>[0-9]+) issue=(?<issue>[0-9]+) -->$"))
  | map(select(.issue == $issue));
'

# Renders a receipt marker. The single source of truth for the grammar the jq
# prelude parses, so a writer and a reader can never disagree.
goobers_lease_marker() {
  local kind="$1" run_id="$2" attempt="$3" issue="$4"
  case "$kind" in
    adopted | disposed) ;;
    *)
      echo "::error::goobers_lease_marker was asked for an unknown receipt kind '${kind}'; that is a bug in .github/workflows/goobers-run.yml, not in the issue." >&2
      return 2
      ;;
  esac
  if ! [[ "$run_id" =~ ^[0-9]+$ ]] || ! [[ "$attempt" =~ ^[0-9]+$ ]] ||
    ! [[ "$issue" =~ ^[0-9]+$ ]]; then
    echo "::error::goobers_lease_marker needs numeric run-id/attempt/issue, got '${run_id}'/'${attempt}'/'${issue}'. GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must both be set on any step that reads or writes a reservation lease." >&2
    return 2
  fi
  printf '<!-- crawler-goobers-reservation-%s:v1 run-id=%s attempt=%s issue=%s -->' \
    "$kind" "$run_id" "$attempt" "$issue"
}

# Reads every comment on an issue into a file, fail-closed.
#
# An unreadable comment list is NOT "no lease": auth failure, a rate limit or a
# transient API error would otherwise read as "this issue is free" and hand a
# possibly live issue to a second agent. Both the gh exit status and an empty
# payload are treated as failure.
goobers_lease_fetch() {
  local repo="$1" issue="$2" out="$3"
  if ! gh api --paginate --slurp \
    "repos/${repo}/issues/${issue}/comments?per_page=100" > "$out" 2> "${out}.err"; then
    echo "::error::Could not read the reservation-lease receipts on issue #${issue} ($(tr '\n' ' ' < "${out}.err" 2> /dev/null)). Refusing to treat the issue as free, because an unreadable comment list cannot be distinguished from a live lease. Retry the dispatch, or inspect it by hand: gh api repos/${repo}/issues/${issue}/comments --jq '.[].body'" >&2
    rm -f "${out}.err"
    return 1
  fi
  rm -f "${out}.err"
  if [ ! -s "$out" ]; then
    echo "::error::The reservation-lease receipt read for issue #${issue} returned an empty payload, so this dispatch cannot prove no other dispatch holds a lease on it. Refusing to select it; retry the dispatch or inspect it by hand: gh api repos/${repo}/issues/${issue}/comments --jq '.[].body'" >&2
    return 1
  fi
  return 0
}

# Prints "state<TAB>run<TAB>attempt<TAB>comment-id" for the LATEST trusted
# adoption receipt on an issue.
#
# "Latest" is by comment id, which is monotonic per repository, and the disposal
# receipt is PATCHed into the adoption comment itself, so adoption order and
# comment-id order agree.
#
# A disposal counts ONLY when both hold:
#
#   * it names the same run-id/attempt lease key as the adoption it is meant to
#     close -- a stale disposal from an earlier dispatch can never satisfy a
#     later adoption; and
#   * it lives in THE SAME COMMENT BODY as that adoption. A trusted author is
#     not enough: `goobers-run.yml` posts other Actions-authored comments whose
#     bodies embed free-form Goobers journal text, which the agent under test
#     writes. Accepting a disposal from any trusted comment would let a journal
#     message that contains a well-formed marker on a line of its own close a
#     live lease -- exactly the "hand a live issue to a second agent" failure
#     the trust rule exists to prevent.
goobers_lease_state() {
  local comments="$1" issue="$2" parsed=""
  if ! parsed="$(
    jq -r \
      --arg login "$GOOBERS_LEASE_TRUSTED_LOGIN" \
      --arg slug "$GOOBERS_LEASE_TRUSTED_APP_SLUG" \
      --arg issue "$issue" \
      "${GOOBERS_LEASE_JQ_PRELUDE}"'
      [ .[][] | select(trusted) | { id: .id, receipts: receipts } ]
      | sort_by(.id)
      | [ .[]
          | . as $comment
          | $comment.receipts[]
          | select(.kind == "adopted")
          | . as $adoption
          | {
              id: $comment.id,
              run: $adoption.run,
              attempt: $adoption.attempt,
              disposed: (
                $comment.receipts
                | any(
                    .kind == "disposed"
                    and .run == $adoption.run
                    and .attempt == $adoption.attempt
                  )
              )
            }
        ] as $adoptions
      | if ($adoptions | length) == 0 then
          "none\t\t\t"
        else
          ($adoptions | last) as $latest
          | (if $latest.disposed then "disposed" else "adopted" end)
            + "\t\($latest.run)\t\($latest.attempt)\t\($latest.id)"
        end
      ' "$comments" 2> /dev/null
  )" || [ -z "$parsed" ]; then
    echo "::error::Could not parse the reservation-lease receipts on issue #${issue}; the comment payload was not the expected GitHub API shape. Refusing to treat the issue as free. Inspect it by hand: gh api repos/${GITHUB_REPOSITORY:-<owner>/<repo>}/issues/${issue}/comments --jq '.[] | {id, login: .user.login, body}'" >&2
    return 1
  fi
  printf '%s\n' "$parsed"
  return 0
}

# One-line human summary for a log message.
goobers_lease_describe() {
  local state="$1" run="$2" attempt="$3" comment_id="$4"
  case "$state" in
    none) printf 'no trusted adoption receipt' ;;
    adopted) printf 'ADOPTED and UNDISPOSED by Actions run %s attempt %s (receipt comment %s)' "$run" "$attempt" "$comment_id" ;;
    disposed) printf 'cleanly disposed by Actions run %s attempt %s (receipt comment %s)' "$run" "$attempt" "$comment_id" ;;
    *) printf 'unrecognised lease state %s' "$state" ;;
  esac
}
