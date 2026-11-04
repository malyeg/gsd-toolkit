# shellcheck shell=bash
# lib/tracker/custom.sh — any tracker, through the repo's own script.
#
# .gsd.conf:  tracker = custom
#             tracker_command = scripts/tracker.sh   (relative to the repo root)
# (or git config gsd-tracker.tracker custom / gsd-tracker.command <script>)
# Called as:  <cmd> start|finish|comment|status <id> <text-or-status>
#             <cmd> snapshot <id>     → prints the ticket as markdown
#             <cmd> check             → exit 0 when set up
#             <cmd> create <where> <title> [option…] · update <id> <option>…
#             <cmd> tasks [option…]   → options as the user wrote them; exit
#                                       nonzero for what the script can't do
# For start/finish, GSD_TRACKER_STATUS holds the configured status name (or is
# empty: the script picks its own). GSD_TRACKER_PROFILE holds tracker_profile
# (or is empty), so the script can pick its login. A nonzero exit is reported, never fatal to
# gsd-start / gsd-finish. A call that runs past GSD_TRACKER_TIMEOUT (60s) is stopped.
# Sourced by bin/gsd-tracker (REPO, die, tracker_status set there).

custom_cmd() {
  local c; c=$(trk_command)
  [ -n "$c" ] || die "tracker = custom needs its script: tracker_command = <script> in .gsd.conf, or git config gsd-tracker.command <script>"
  [ -x "$c" ] || die "tracker_command '$c' is not an executable file"
  printf '%s\n' "$c"
}

custom_timed() {  # $@=the script and its args — stopped after GSD_TRACKER_TIMEOUT seconds (default 60)
  # gsd-start / gsd-finish wait for the tracker; a script stuck on the network
  # must not hang them. Perl, since macOS has no `timeout`.
  perl -e '
    my $t = shift; my $pid = fork; defined $pid or die "fork: $!\n";
    if (!$pid) { exec { $ARGV[0] } @ARGV or exit 127 }
    $SIG{ALRM} = sub {
      kill "TERM", $pid; sleep 1; kill "KILL", $pid;
      print STDERR "tracker_command gave no answer in ${t}s — stopped it\n"; exit 124;
    };
    alarm $t; waitpid $pid, 0;
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "${GSD_TRACKER_TIMEOUT:-60}" "$@"
}

tracker_run() {  # $1=command, rest=args
  local cmd="$1" c; shift
  c=$(custom_cmd) || exit 1
  trk_get profile; GSD_TRACKER_PROFILE=$TRK_VAL; export GSD_TRACKER_PROFILE
  case "$cmd" in
    start|finish) GSD_TRACKER_STATUS=$(tracker_status "$cmd") custom_timed "$c" "$cmd" "$@" || exit 2 ;;
    *) GSD_TRACKER_STATUS="" custom_timed "$c" "$cmd" "$@" || exit 2 ;;
  esac
}
