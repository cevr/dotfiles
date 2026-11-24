#!/bin/sh
# `workrift processes` (the subvolume switch's walk over /proc) on a real Linux /proc, as this user, in a VM:
#   sh proc-walk-linux.sh <workrift>
# workrift-proc-walk.test.ts copies both into a Lima VM (WORKRIFT_LIMA names it) and runs this; it needs sudo -n
# (Lima's default user has it) and setpriv (util-linux). Every process it starts is in its own scratch and ends with
# it. One line a check, PASS or FAIL; the exit status is the count of FAIL.
#
# (a) The workbox's case: a process of this user's own uid whose fd folder lists but whose links do not read. Made
#     here as the user's systemd is there: a process that holds a capability this user lacks (an ambient
#     cap_net_bind_service, through setpriv as root, back to this uid). Its exec keeps it dumpable, so its
#     /proc folder is this user's and lists; but the kernel's ptrace read check refuses its links (its permitted
#     capabilities are no subset of the walker's): readlink of its fd/N, cwd, root and exe answers EACCES.
# (b) Processes that end during the walk: 50 walks beside a loop of short-lived children, none refused.
# (c) A walk that truly fails (no process folder at all) still refuses, with find's line.
set -u
W=${1:?usage: proc-walk-linux.sh <workrift>}
fails=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
S=$(mktemp -d /tmp/proc-walk.XXXXXX) || exit 1
mkdir "$S/in" "$S/out" "$S/churn" "$S/bin"
# A sudo that is not there (the host with no sudo -n): first on PATH for the runs that name it.
printf '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n' >"$S/bin/sudo"
chmod +x "$S/bin/sudo"
nosudo() { PATH="$S/bin:$PATH" "$@"; }
pids=
end() {
  for p in $pids; do sudo -n kill "$p" 2>/dev/null; done
  rm -rf "$S"
}
trap end EXIT

# (a) The process, its cwd in the folder.
uid=$(id -u)
gid=$(id -g)
# sudo runs setpriv in a child, which execs sleep: the process is found by its own argument (this run's pid).
mark="299.$$"
(cd "$S/in" && exec sudo -n setpriv --reuid="$uid" --regid="$gid" --init-groups --inh-caps=+net_bind_service --ambient-caps=+net_bind_service sleep "$mark") &
pids="$pids $!"
held=
i=0
while [ -z "$held" ] && [ "$i" -lt 100 ]; do
  held=$(pgrep -u "$uid" -x -f "sleep $mark")
  [ -n "$held" ] || sleep 0.05
  i=$((i + 1))
done
pids="$pids $held"
owner=$(stat -c %u "/proc/$held/fd")
ls "/proc/$held/fd" >/dev/null 2>&1 && listed=yes || listed=no
readlink -v "/proc/$held/fd/0" >/dev/null 2>"$S/readlink.err" && linked=yes || linked=no
if [ "$owner" = "$uid" ] && [ "$listed" = yes ] && [ "$linked" = no ] && grep -q 'Permission denied' "$S/readlink.err"; then
  pass "(a) the process $held is this user's ($owner), its fd folder lists, its links do not read (EACCES)"
else
  fail "(a) not reproduced: owner $owner, listed $listed, linked $linked: $(cat "$S/readlink.err")"
fi

out=$(sh "$W" processes "$S/in" 2>&1)
rc=$?
# The VM has other processes the walk cannot look into (root's, system users'): each check names this one.
case "$rc:$out" in
  3:*"
$held sleep (uid $uid, read with sudo)"*) pass "(a) with sudo -n: read again and judged: in the folder ($rc)" ;;
  *) fail "(a) with sudo -n, in the folder: exit $rc: $out" ;;
esac
out=$(sh "$W" processes "$S/out" 2>&1)
rc=$?
case "$rc:$out" in
  0:*"/proc/$held/fd "*"none works in"*) pass "(a) with sudo -n: read again and judged: not in another folder ($rc)" ;;
  *) fail "(a) with sudo -n, another folder: exit $rc: $out" ;;
esac
out=$(nosudo sh "$W" processes "$S/in" 2>&1)
rc=$?
case "$rc:$out" in
  2:*"process(es) of uid "*" $uid"*" could not be looked into"*) pass "(a) without sudo -n: unread, refused ($rc)" ;;
  *) fail "(a) without sudo -n: exit $rc: $out" ;;
esac
out=$(nosudo sh "$W" processes "$S/in" --beside-unreadable 2>&1)
rc=$?
case "$rc:$out" in
  0:*"beside "*"(pids"*" $held"*"none works in"*) pass "(a) without sudo -n, --beside-unreadable: beside it ($rc)" ;;
  *) fail "(a) without sudo -n, --beside-unreadable: exit $rc: $out" ;;
esac
sudo -n kill "$held"
wait

# (b) A loop of short-lived children (each in the folder walked, some holding a file open in it) beside 50 walks.
(
  cd "$S/churn" || exit 1
  while [ ! -e "$S/stop" ]; do
    for k in 1 2 3 4 5 6 7 8; do (exec 3>"$S/churn/f$k"; :) & done
    wait
  done
) &
churn=$!
pids="$pids $churn"
refused=0
ended=0
for n in $(seq 1 50); do
  out=$(sh "$W" processes "$S/out" 2>&1)
  rc=$?
  [ "$rc" = 0 ] || { refused=$((refused + 1)); echo "  walk $n: exit $rc: $out"; }
  e=$(printf '%s\n' "$out" | sed -n 's/.*ended during the walk \([0-9]*\),.*/\1/p')
  ended=$((ended + ${e:-0}))
done
: >"$S/stop"
wait "$churn"
if [ "$refused" = 0 ]; then
  pass "(b) 50 walks beside processes ending: none refused ($ended ended during a walk, counted)"
else
  fail "(b) $refused of 50 walks refused"
fi

# (c) No process folder: the walk failed, said with find's line.
out=$(WORKRIFT_PROC=/nonexistent/loop-probe-x sh "$W" processes "$S/in" 2>&1)
rc=$?
case "$rc:$out" in
  1:*"find over /nonexistent/loop-probe-x failed; it said: find: '/nonexistent/loop-probe-x': No such file or directory"*) pass "(c) a walk that fails refuses, with find's line ($rc)" ;;
  *) fail "(c) exit $rc: $out" ;;
esac

echo "proc-walk-linux: $fails FAIL"
exit "$fails"
