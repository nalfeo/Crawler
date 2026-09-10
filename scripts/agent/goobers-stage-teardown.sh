#!/usr/bin/env bash
# Terminate the FULL process tree a Goobers slot leads, then prove it is gone.
#
# Why this exists
# ---------------
# `goobers-run.yml` bounds each slot at GOOBERS_SLOT_DEADLINE_SECONDS and then
# has to stop it before the job's cleanup releases provider claims and issue
# labels. Signalling the `goobers run` pid alone does NOT stop the run:
#
#   * Goobers detaches every stage into its OWN SESSION, not merely its own
#     process group -- `internal/platform/proc/proc_unix.go`'s `configure` sets
#     `SysProcAttr.Setsid` (and `internal/executor/shell.go` /
#     `internal/harness/process.go` both spawn through it). A session leader's
#     pgid equals its own pid, so `kill -TERM -<goobers-run-pgid>` never reaches
#     a stage, and neither does killing the parent.
#   * SIGTERM does not even cancel the stage that is already running. The runner
#     dispatches each attempt on `context.WithoutCancel(ctx)` and only checks
#     cancellation BETWEEN stages (`internal/runner/run.go`), so a signalled
#     `goobers run` keeps its in-flight Copilot/verification children alive and
#     merely declines to start the next stage.
#   * The pinned build has no daemon-free cancellation command: `goobers run
#     cancel` hands the request to a live `goobers up` daemon through
#     `scheduler/pending-cancels` and only `up.go` sweeps that directory
#     (`cmd/goobers/runcancel.go`), and this workflow deliberately runs bare
#     `goobers run` instances instead of a daemon. `goobers run abort` is the
#     sanctioned daemon-down path, but it is journal repair -- it does not
#     signal anything.
#
# Left alone, those descendants keep pushing branches and commenting while the
# job releases the claim that was supposed to own them. So the Actions wrapper
# terminates the tree itself, using the same mechanism Goobers uses internally
# (`Tree.kill`: snapshot descendants from /proc BEFORE signalling, then signal
# each one guarded by its start time so a recycled pid cannot be hit), extended
# with the session axis that Setsid makes necessary.
#
# Selection is exact -- never a process-name match:
#   1. the /proc ppid closure rooted at the slot's `goobers run` pid, seeded
#      ONLY when that pid still carries the start time the caller recorded when
#      it launched it (see the root schema below);
#   2. every process whose session id belongs to a process already in the
#      closure and is not this script's own session (a session id only ever
#      comes from a setsid(2) call, so a stage's session contains that stage's
#      descendants and nothing else, including descendants that were reparented
#      to init when their stage died);
#   3. every process whose environment contains GOOBERS_INSTANCE=<slot root>
#      -- the per-slot identity `goobers-run.yml` exports and lists in
#      `runner.envPassthrough`, so it is inherited by every stage descendant.
#      This is what still finds the tree after the root process has exited.
#
# The script's own pid and every one of its ancestors are excluded, so the sweep
# can never signal the Actions runner or the step's shell.
#
# ROOT SCHEMA -- `<pid>:<start-time>`, never a bare pid
# ----------------------------------------------------
# A pid is not an identity. Linux recycles pids, and the window between a slot
# being launched and its deadline being reached is tens of minutes on a busy
# runner, so by the time the teardown runs "pid 4321" may be an unrelated
# process -- plausibly one of the Actions runner's own. Seeding the closure from
# a recycled pid would sweep that process, its children AND its whole session.
#
# So every root is passed as `<pid>:<start-time>`, where the start time is
# /proc/<pid>/stat field 22 (the process's start time in clock ticks since
# boot), read by the caller IMMEDIATELY after the launch that produced the pid:
#
#   slot_pid=$!
#   slot_start="$(goobers_teardown_pid_start "$slot_pid")"
#   ...
#   goobers_teardown_tree "$slot_root" 120 "${slot_pid}:${slot_start}"
#
# (pid, start time) is unique for the lifetime of a boot, so it names the exact
# process the caller launched and nothing else. A root whose pid is gone is
# skipped silently -- it already exited, and selector 3 still finds any
# descendant it left behind. A root whose pid EXISTS with a different start time
# is a recycled pid: it is skipped with a `::warning::`, and neither it nor its
# session is signalled. A bare pid is refused outright (exit 2) rather than
# guessed at, so a caller cannot silently regress to the unsafe form.
#
# Usage:
#   goobers-stage-teardown.sh <instance-root> <grace-seconds> [<pid>:<start> ...]
#
# Exit codes: 0 = the tree is gone, 1 = something survived SIGKILL (the caller
# must NOT release claims or labels), 2 = usage error.
#
# Deliberately no top-level `set`: this file is sourced by goobers-run.yml's
# "Run the workflow" step, which runs without `-e` on purpose, and a library
# must not silently change its caller's shell options. The CLI entry point at
# the bottom sets its own.

# How long, after SIGKILL, the sweep keeps re-checking before it declares the
# tree unkillable and fails closed. Named (not inlined) because
# goobers-run.yml's cleanup reserve is computed from it: a structural test reads
# this literal and asserts the reserve still covers the worst case.
GOOBERS_TEARDOWN_VERIFY_SECONDS=15

# Wall-clock allowance for the NON-sleeping work of one goobers_teardown_tree
# call: three full /proc snapshots plus their fixed-point member expansions, the
# per-member environ reads, and two signal passes. On a busy runner with
# hundreds of processes that is seconds, not milliseconds, and it is time the
# `grace + verify` arithmetic alone does not account for. The cleanup reserve
# adds this per teardown so a slow sweep cannot eat the window the journal
# uploads and claim/label mutations need afterwards.
GOOBERS_TEARDOWN_SWEEP_SLACK_SECONDS=30

goobers_teardown_usage() {
  cat >&2 <<'USAGE'
Usage: goobers-stage-teardown.sh <instance-root> <grace-seconds> [<pid>:<start> ...]

Terminates every process a Goobers slot leads and verifies none survive.

Each root is the launched pid AND its /proc stat start time (field 22), read by
the caller immediately after the launch. A bare pid is refused: a pid alone
cannot be told apart from a pid Linux has since recycled onto an unrelated
process, and seeding the sweep from one would signal that process, its children
and its whole session.
USAGE
}

# True when a root argument carries both halves of a process identity.
goobers_teardown_valid_root() {
  [[ "$1" =~ ^[0-9]+:[0-9]+$ ]]
}

# Prints /proc/<pid>/stat field 22 (start time in clock ticks since boot), or
# nothing when the process is gone or unreadable.
#
# Field 2 (comm) is unquoted and may contain spaces and parentheses, so
# everything is read after the LAST ") ": awk's greedy `.*` guarantees the final
# one. The remaining tokens are stat fields 3..N, making start time token 20.
#
# This is the one place that arithmetic lives. The launch site in
# `goobers-run.yml` records a root's start time with it, and the signal and
# liveness checks below re-read it with it, so a writer and a reader cannot
# disagree about which field a "start time" is.
goobers_teardown_pid_start() {
  awk '{ rest = $0; if (sub(/^.*\) /, "", rest) == 0) exit; n = split(rest, f, " "); if (n >= 20) print f[20] }' \
    "/proc/${1}/stat" 2>/dev/null
}

# Prints "pid ppid session starttime" for every readable process.
#
# awk reads each /proc file with `getline`, driven by the /proc listing, rather
# than taking the glob as its argv. That is not a style choice: a pid that exits
# between the glob and the open makes awk (both gawk and mawk) fatally exit,
# and every later /proc entry would be silently missing from the snapshot. A
# truncated snapshot is the worst possible failure here -- it can drop live
# stage processes (a false "fully terminated") and, if it drops this script's
# own entry, it can widen the sweep. `getline` returns -1 for an unreadable
# file instead, so a process that exits mid-sweep is simply absent, which is
# correct: it is already gone.
#
# /proc/<pid>/stat field 2 (comm) is unquoted and may contain spaces and
# parentheses, so everything is read after the LAST ") ": awk's greedy `.*`
# guarantees the final one. The remaining tokens are stat fields 3..N, making
# ppid token 2, session token 4 and starttime token 20.
goobers_teardown_snapshot() {
  ls -1 /proc 2>/dev/null | awk '
    /^[0-9]+$/ {
      pid = $0
      path = "/proc/" pid "/stat"
      line = ""
      if ((getline line < path) <= 0) {
        close(path)
        next
      }
      close(path)
      rest = line
      if (sub(/^.*\) /, "", rest) == 0) { next }
      n = split(rest, field, " ")
      if (n < 20) { next }
      print pid, field[2], field[4], field[20]
    }
  '
}

# Prints the pids of this process and all of its ancestors. Never signalled.
goobers_teardown_ancestors() {
  local snapshot="$1" current="$2" guard=0 parent=""
  while [ "$current" -gt 0 ] && [ "$guard" -lt 128 ]; do
    printf '%s\n' "$current"
    parent="$(awk -v target="$current" '$1 == target { print $2; exit }' "$snapshot")"
    [ -n "$parent" ] || break
    current="$parent"
    guard=$((guard + 1))
  done
}

# True when pid's environment declares this slot's instance root.
#
# The read is a command substitution rather than `tr ... | grep -q` on purpose:
# under `set -o pipefail` (which the workflow steps that source this file do
# set) an early-exiting `grep -q` can SIGPIPE the writer and turn a genuine
# match into a non-zero pipeline status, which would silently drop a live stage
# from the sweep.
goobers_teardown_owns_instance() {
  local pid="$1" root="$2" environ=""
  [ -n "$root" ] || return 1
  [ -r "/proc/${pid}/environ" ] || return 1
  environ="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null)" || return 1
  grep -qxF "GOOBERS_INSTANCE=${root}" <<<"$environ"
}

# Prints "pid starttime" for every member of the slot's tree.
#
# Returns 1 without printing anything when the snapshot cannot be trusted. The
# one non-negotiable precondition is that this script's own entry is in it: the
# whole exclusion story (own pid, own ancestors, own session) is derived from
# it, so a snapshot missing it could widen the sweep onto the Actions runner.
# Fail closed instead.
goobers_teardown_members() {
  local snapshot="$1" root="$2"
  shift 2
  local self_session excluded=" " members=" " sessions=" " changed=1
  local pid ppid session start ancestor seed seed_pid seed_start observed_start

  self_session="$(awk -v target="$$" '$1 == target { print $3; exit }' "$snapshot")"
  if [ -z "$self_session" ]; then
    echo "::error::goobers-stage-teardown.sh could not find its own process ($$) in the /proc snapshot, so it cannot tell this job's stage tree from the Actions runner's own processes. Refusing to signal anything; inspect the runner with 'ps -eo pid,ppid,sess,args' and re-run the dispatch." >&2
    return 1
  fi
  while read -r ancestor; do
    [ -n "$ancestor" ] || continue
    excluded="${excluded}${ancestor} "
  done <<EOF
$(goobers_teardown_ancestors "$snapshot" "$$")
EOF
  # init is never a member, whatever it reparented.
  excluded="${excluded}1 "

  # Seed the closure from the caller's roots, but ONLY where the live process
  # is still the one the caller launched. `pid` alone is not an identity: Linux
  # recycles pids, and a slot's deadline can be tens of minutes after its
  # launch, so seeding from a recycled pid would sweep an unrelated process,
  # its children and -- through the session axis below -- its entire session.
  for seed in "$@"; do
    if ! goobers_teardown_valid_root "$seed"; then
      echo "::error::goobers-stage-teardown.sh was given the root '${seed}' for instance ${root}, which is not the required <pid>:<start-time> form. A bare pid cannot be distinguished from a recycled one, so nothing was signalled. Fix the caller to record the start time with goobers_teardown_pid_start immediately after the launch (see .github/workflows/goobers-run.yml's \"Run the workflow\" step)." >&2
      return 1
    fi
    seed_pid="${seed%%:*}"
    seed_start="${seed#*:}"
    case "$excluded" in *" $seed_pid "*) continue ;; esac
    case "$members" in *" $seed_pid "*) continue ;; esac
    observed_start="$(awk -v target="$seed_pid" '$1 == target { print $4; exit }' "$snapshot")"
    # Already gone. Normal: the root exits first on every healthy path, and any
    # descendant it left behind is still found by GOOBERS_INSTANCE below.
    [ -n "$observed_start" ] || continue
    if [ "$observed_start" != "$seed_start" ]; then
      echo "::warning::goobers-stage-teardown.sh is not seeding root pid ${seed_pid} for instance ${root}: it was launched at start time ${seed_start}, but the live process holding that pid started at ${observed_start}, so the pid was recycled onto an unrelated process. Neither it nor its session will be signalled; any true descendant of the original root is still found through GOOBERS_INSTANCE=${root}." >&2
      continue
    fi
    members="${members}${seed_pid} "
  done

  # The environ selector runs first so a slot whose root process has already
  # exited (killed job, OOM) still seeds the closure.
  while read -r pid ppid session start; do
    [ -n "$pid" ] || continue
    case "$excluded" in *" $pid "*) continue ;; esac
    case "$members" in *" $pid "*) continue ;; esac
    if goobers_teardown_owns_instance "$pid" "$root"; then
      members="${members}${pid} "
    fi
  done < "$snapshot"

  # Fixed-point expansion over parenthood and session membership.
  while [ "$changed" = "1" ]; do
    changed=0
    while read -r pid ppid session start; do
      [ -n "$pid" ] || continue
      case "$excluded" in *" $pid "*) continue ;; esac
      if [ "$session" != "$self_session" ]; then
        case "$members" in
          *" $pid "*)
            case "$sessions" in
              *" $session "*) ;;
              *)
                sessions="${sessions}${session} "
                changed=1
                ;;
            esac
            ;;
        esac
      fi
      case "$members" in *" $pid "*) continue ;; esac
      case "$members" in
        *" $ppid "*)
          members="${members}${pid} "
          changed=1
          continue
          ;;
      esac
      if [ "$session" != "$self_session" ]; then
        case "$sessions" in
          *" $session "*)
            members="${members}${pid} "
            changed=1
            continue
            ;;
        esac
      fi
    done < "$snapshot"
  done

  while read -r pid ppid session start; do
    [ -n "$pid" ] || continue
    case "$members" in *" $pid "*) printf '%s %s\n' "$pid" "$start" ;; esac
  done < "$snapshot"
}

# Signals each member, re-reading its start time first so a pid recycled onto an
# unrelated process since the snapshot is skipped -- the same guard Goobers'
# own `processIdentity.signal` applies.
goobers_teardown_signal() {
  local signal="$1" members_file="$2" pid start current signalled=0
  while read -r pid start; do
    [ -n "$pid" ] || continue
    current="$(goobers_teardown_pid_start "$pid")"
    [ -n "$current" ] || continue
    [ "$current" = "$start" ] || continue
    kill "-${signal}" "$pid" 2>/dev/null && signalled=$((signalled + 1))
  done < "$members_file"
  printf '%s\n' "$signalled"
}

goobers_teardown_alive_count() {
  local members_file="$1" pid start current alive=0
  while read -r pid start; do
    [ -n "$pid" ] || continue
    current="$(goobers_teardown_pid_start "$pid")"
    [ -n "$current" ] || continue
    [ "$current" = "$start" ] || continue
    alive=$((alive + 1))
  done < "$members_file"
  printf '%s\n' "$alive"
}

# Refreshes snapshot+members in one fail-closed step: any snapshot we cannot
# trust (empty, or missing this script's own entry) aborts rather than
# producing a member list that merely looks empty.
goobers_teardown_collect() {
  local snapshot="$1" members="$2" root="$3"
  shift 3
  goobers_teardown_snapshot > "$snapshot"
  if [ ! -s "$snapshot" ]; then
    echo "::error::goobers-stage-teardown.sh read an empty /proc snapshot while tearing down instance ${root}, so it cannot prove the stage tree is gone. Provider claims and issue labels must NOT be released; inspect the runner with 'ps -eo pid,ppid,sess,args'." >&2
    return 1
  fi
  goobers_teardown_members "$snapshot" "$root" "$@" > "$members"
}

# SIGTERM the whole tree, wait out the grace period, SIGKILL whatever is left,
# then verify. Re-snapshots between phases so a child spawned during the grace
# period is caught too.
goobers_teardown_tree() {
  local root="$1" grace="$2"
  shift 2
  local snapshot members waited alive killed status seed

  if [ ! -d /proc/self ]; then
    echo "::error::goobers-stage-teardown.sh needs a Linux /proc filesystem to enumerate a Goobers stage tree; it cannot run on this host. Run the Goobers slots on ubuntu-latest." >&2
    return 1
  fi

  # Usage, checked before anything is snapshotted or signalled: a caller that
  # passes a bare pid has lost the only evidence that distinguishes the process
  # it launched from whatever Linux has since recycled that pid onto.
  for seed in "$@"; do
    if ! goobers_teardown_valid_root "$seed"; then
      goobers_teardown_usage
      echo "::error::goobers-stage-teardown.sh needs every root as <pid>:<start-time>, got '${seed}' while tearing down instance ${root}. Record the start time with goobers_teardown_pid_start immediately after the launch that produced the pid." >&2
      return 2
    fi
  done

  snapshot="$(mktemp)"
  members="$(mktemp)"

  if ! goobers_teardown_collect "$snapshot" "$members" "$root" "$@"; then
    rm -f "$snapshot" "$members"
    return 1
  fi
  echo "Teardown for instance ${root}: $(wc -l < "$members" | tr -d ' ') process(es) in the stage tree (roots: $*)."
  goobers_teardown_signal TERM "$members" > /dev/null

  waited=0
  while [ "$waited" -lt "$grace" ]; do
    if [ "$(goobers_teardown_alive_count "$members")" = "0" ]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! goobers_teardown_collect "$snapshot" "$members" "$root" "$@"; then
    rm -f "$snapshot" "$members"
    return 1
  fi
  killed="$(goobers_teardown_signal KILL "$members")"
  if [ "$killed" != "0" ]; then
    echo "Teardown for instance ${root}: SIGKILLed ${killed} process(es) that outlived the ${grace}s grace period."
  fi

  waited=0
  alive="an unknown number of"
  status=1
  while [ "$waited" -lt "$GOOBERS_TEARDOWN_VERIFY_SECONDS" ]; do
    if ! goobers_teardown_collect "$snapshot" "$members" "$root" "$@"; then
      rm -f "$snapshot" "$members"
      return 1
    fi
    alive="$(goobers_teardown_alive_count "$members")"
    if [ "$alive" = "0" ]; then
      echo "Teardown for instance ${root}: stage tree fully terminated."
      status=0
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$status" = "0" ]; then
    rm -f "$snapshot" "$members"
    return 0
  fi

  echo "::error::Goobers stage tree for instance ${root} still has ${alive} live process(es) after SIGKILL: $(cut -d' ' -f1 < "$members" | tr '\n' ' '). Provider claims and issue labels must NOT be released while those keep running; inspect the runner with 'ps -eo pid,ppid,sess,args' and re-run the dispatch once it is clear." >&2
  rm -f "$snapshot" "$members"
  return 1
}

# Only run the CLI when executed directly; `Run the workflow` sources this file
# so the deadline path can call goobers_teardown_tree without a subprocess.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -uo pipefail
  if [ "$#" -lt 2 ]; then
    goobers_teardown_usage
    exit 2
  fi
  goobers_teardown_tree "$@"
  exit $?
fi
