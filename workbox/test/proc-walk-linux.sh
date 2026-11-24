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
# (d) A process tied to the folder only by a mapped file: mmap through libc (python3's ctypes: its mmap module
#     would keep a dup of the fd), the fd closed, its working folder /.
# (e) A thread with its own working folder in the folder: unshare(CLONE_FS) in that thread, then chdir (its
#     process's working folder stays /). /proc/<pid>/cwd is the main thread's; /proc/<pid>/task/<tid>/cwd its own.
# (f) A proc mounted with hidepid=invisible (a mount of its own, beside /proc): other users' processes are not listed.
# (g) A thread with its own file table: unshare(CLONE_FILES) in that thread (the real call that gives a running
#     thread a table of its own; clone without CLONE_FILES makes a process, not a thread of this one), then open a
#     file in the folder: only /proc/<pid>/task/<tid>/fd holds it, not /proc/<pid>/fd; working folders /.
# (h) A proc mounted with hidepid=1: other users' processes are listed, but every entry of theirs answers EPERM
#     ("Operation not permitted"): each is unread, read again with sudo -n (a root process in the folder named), or
#     refused without it, or beside them with --beside-unreadable.
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
  ! mountpoint -q "$S/proc" 2>/dev/null || sudo -n umount "$S/proc"
  ! mountpoint -q "$S/proc1" 2>/dev/null || sudo -n umount "$S/proc1"
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

# (d) The mapped file.
dd if=/dev/zero of="$S/in/blob" bs=4096 count=1 2>/dev/null
(cd "$S/out" && exec python3 -c '
import ctypes, os, sys, time
libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
fd = os.open(sys.argv[1], os.O_RDONLY)
at = libc.mmap(None, 4096, 1, 1, fd, 0)
if at in (None, ctypes.c_void_p(-1).value):
    raise SystemExit("mmap failed")
os.close(fd)
os.chdir("/")
open(sys.argv[2], "w").close()
time.sleep(300)
' "$S/in/blob" "$S/mapped.ready" </dev/null >/dev/null 2>&1) &
mapped=$!
pids="$pids $mapped"
i=0
while [ ! -e "$S/mapped.ready" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
nfd=$(for f in /proc/"$mapped"/fd/*; do readlink "$f"; done | grep -c "^$S/in")
if [ "$nfd" = 0 ] && [ "$(readlink "/proc/$mapped/cwd")" = / ] && grep -q " $S/in/blob" "/proc/$mapped/maps"; then
  pass "(d) the process $mapped maps $S/in/blob with no fd on it and its working folder /"
else
  fail "(d) not reproduced: fd $nfd, cwd $(readlink "/proc/$mapped/cwd"), maps $(grep -c "$S/in" "/proc/$mapped/maps" 2>&1)"
fi
out=$(sh "$W" processes "$S/in" 2>&1)
rc=$?
case "$rc:$out" in
  3:*"
$mapped python3"*) pass "(d) a mapped file in the folder: the process is named ($rc)" ;;
  *) fail "(d) a mapped file: exit $rc: $out" ;;
esac
kill "$mapped"
wait "$mapped" 2>/dev/null

# (e) The thread.
(cd / && exec python3 -c '
import ctypes, os, sys, threading, time
libc = ctypes.CDLL(None, use_errno=True)
def own():
    if libc.unshare(0x00000200) != 0:
        raise SystemExit("unshare(CLONE_FS) failed")
    os.chdir(sys.argv[1])
    open(sys.argv[2], "w").close()
    time.sleep(300)
threading.Thread(target=own, daemon=True).start()
time.sleep(300)
' "$S/in" "$S/thread.ready" </dev/null >/dev/null 2>&1) &
threaded=$!
pids="$pids $threaded"
i=0
while [ ! -e "$S/thread.ready" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
tcwd=$(for t in /proc/"$threaded"/task/*; do readlink "$t/cwd"; done | grep -c "^$S/in$")
if [ "$(readlink "/proc/$threaded/cwd")" = / ] && [ "$tcwd" = 1 ]; then
  pass "(e) the process $threaded works in / and one of its threads in $S/in"
else
  fail "(e) not reproduced: cwd $(readlink "/proc/$threaded/cwd"), threads in the folder $tcwd"
fi
out=$(sh "$W" processes "$S/in" 2>&1)
rc=$?
case "$rc:$out" in
  3:*"
$threaded python3"*) pass "(e) a thread in the folder: the process is named ($rc)" ;;
  *) fail "(e) a thread in the folder: exit $rc: $out" ;;
esac
kill "$threaded"
wait "$threaded" 2>/dev/null

# (g) The thread with its own file table.
(cd / && exec python3 -c '
import ctypes, os, sys, threading, time
libc = ctypes.CDLL(None, use_errno=True)
def own():
    if libc.unshare(0x00000400) != 0:
        raise SystemExit("unshare(CLONE_FILES) failed")
    os.open(sys.argv[1], os.O_RDONLY)
    open(sys.argv[2], "w").close()
    time.sleep(300)
threading.Thread(target=own, daemon=True).start()
time.sleep(300)
' "$S/in/blob" "$S/files.ready" </dev/null >/dev/null 2>&1) &
filed=$!
pids="$pids $filed"
i=0
while [ ! -e "$S/files.ready" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
pfd=$(for f in /proc/"$filed"/fd/*; do readlink "$f"; done | grep -c "^$S/in")
tfd=$(for f in /proc/"$filed"/task/*/fd/*; do readlink "$f"; done | grep -c "^$S/in")
if [ "$pfd" = 0 ] && [ "$tfd" = 1 ] && [ "$(readlink "/proc/$filed/cwd")" = / ]; then
  pass "(g) the process $filed has no fd in $S/in, one of its threads has one in its own table, its working folder /"
else
  fail "(g) not reproduced: process fds $pfd, thread fds $tfd, cwd $(readlink "/proc/$filed/cwd")"
fi
out=$(sh "$W" processes "$S/in" 2>&1)
rc=$?
case "$rc:$out" in
  3:*"
$filed python3"*) pass "(g) a thread's own fd in the folder: the process is named ($rc)" ;;
  *) fail "(g) a thread's own fd in the folder: exit $rc: $out" ;;
esac
kill "$filed"
wait "$filed" 2>/dev/null

# (h) hidepid=1: a root process in the folder.
rmark="298.$$"
(cd "$S/in" && exec sudo -n sleep "$rmark") &
pids="$pids $!"
rheld=
i=0
while [ -z "$rheld" ] && [ "$i" -lt 100 ]; do
  rheld=$(pgrep -u 0 -x -f "sleep $rmark")
  [ -n "$rheld" ] || sleep 0.05
  i=$((i + 1))
done
pids="$pids $rheld"
mkdir "$S/proc1"
if [ -n "$rheld" ] && sudo -n mount -t proc -o hidepid=1 proc "$S/proc1"; then
  if cat "$S/proc1/$rheld/stat" >/dev/null 2>"$S/eperm.err" || ! grep -q 'Operation not permitted' "$S/eperm.err"; then
    fail "(h) not reproduced: the root process's stat under hidepid=1 did not answer EPERM: $(cat "$S/eperm.err")"
  else
    pass "(h) under hidepid=1 the root process $rheld is listed and its entries answer EPERM"
  fi
  out=$(WORKRIFT_PROC="$S/proc1" sh "$W" processes "$S/in" 2>&1)
  rc=$?
  case "$rc:$out" in
    3:*"
$rheld "*"read with sudo"*) pass "(h) hidepid=1 with sudo -n: unread, read again, the root process named ($rc)" ;;
    *) fail "(h) hidepid=1 with sudo -n: exit $rc: $out" ;;
  esac
  out=$(WORKRIFT_PROC="$S/proc1" nosudo sh "$W" processes "$S/in" 2>&1)
  rc=$?
  case "$rc:$out" in
    2:*"could not be looked into"*) pass "(h) hidepid=1 without sudo -n: unread, refused ($rc)" ;;
    *) fail "(h) hidepid=1 without sudo -n: exit $rc: $out" ;;
  esac
  out=$(WORKRIFT_PROC="$S/proc1" nosudo sh "$W" processes "$S/in" --beside-unreadable 2>&1)
  rc=$?
  case "$rc:$out" in
    0:*) pass "(h) hidepid=1 without sudo -n, --beside-unreadable: beside them ($rc)" ;;
    *) fail "(h) hidepid=1 without sudo -n, --beside-unreadable: exit $rc: $out" ;;
  esac
  sudo -n umount "$S/proc1"
else
  fail "(h) no root process ($rheld) or the proc mount with hidepid=1 did not mount"
fi

# (f) hidepid.
mkdir "$S/proc"
if sudo -n mount -t proc -o hidepid=invisible proc "$S/proc"; then
  out=$(WORKRIFT_PROC="$S/proc" sh "$W" processes "$S/out" 2>&1)
  rc=$?
  case "$rc:$out" in
    2:*"$S/proc is mounted with hidepid=invisible: it does not list other users' processes at all"*) pass "(f) hidepid=invisible: the walk is unread as a whole, refused ($rc)" ;;
    *) fail "(f) hidepid=invisible: exit $rc: $out" ;;
  esac
  out=$(WORKRIFT_PROC="$S/proc" sh "$W" processes "$S/out" --beside-unreadable 2>&1)
  rc=$?
  case "$rc:$out" in
    0:*"beside the processes $S/proc hides (hidepid=invisible)"*) pass "(f) hidepid=invisible, --beside-unreadable: beside them, said ($rc)" ;;
    *) fail "(f) hidepid=invisible, --beside-unreadable: exit $rc: $out" ;;
  esac
  sudo -n umount "$S/proc"
else
  fail "(f) the proc mount with hidepid=invisible did not mount"
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
