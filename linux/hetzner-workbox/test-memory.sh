#!/usr/bin/env bash
# Behavior test in test.sh's dedicated Linux VM user and cgroups. No OpenCode daemon or data.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
box=$here/../../workbox
work=$1 user=$2 uid=$3
uctl() { runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" "$@"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
[[ $user == hbtest && $home == /var/tmp/hetzner-workbox-test.*/target/home/hbtest ]] || die "not the memory test's temporary user"
install -d -o "$uid" -g "$uid" "$work" "$home/.local/bin" "$home/.config/systemd/user"
uctl ln -s "$work" "$home/.workbox-memory-test"
rootcg=/sys/fs/cgroup/user.slice
usercg=$rootcg/user-$uid.slice
manager=$usercg/user@$uid.service
cg() { printf '/sys/fs/cgroup%s\n' "$(awk -F: '$1 == 0 { print $3 }' "/proc/$1/cgroup")"; }
ectl() { awk -v key="$2" '$1 == key { print $2; found=1 } END { if (!found) print 0 }' "$1"; }
live() {
    local state
    state=$(sed -E 's/^.*\) ([^ ]).*$/\1/' "/proc/$1/stat" 2>/dev/null) &&
        [[ -n $state && $state != Z ]]
}
until_file() {
    local i
    for i in $(seq 1 125); do [[ -s $1 ]] && return 0; sleep 0.04; done
    die "fixture did not write $1"
}
cleanup() {
    uctl systemctl --user stop opencode.service hbt-memory-survivor.scope >/dev/null 2>&1 || true
}
trap cleanup EXIT
uctl install -m 0755 "$box/bin/workbox-run" "$box/bin/workbox-opencode-recover" "$home/.local/bin/"
uctl install -m 0755 "$here/test-memory-fixture.py" "$home/.local/bin/opencode"
uctl install -m 0644 "$box/systemd/user/opencode.service" "$box/systemd/user/workbox-opencode-watch."{service,timer} "$home/.config/systemd/user/"
uctl systemctl --user daemon-reload
units=(opencode.slice ergo.slice bite-work.slice personal.slice app.slice)
families=(opencode ergo bite-work personal default)
uctl systemctl --user start "${units[@]}" opencodeserver.slice
paths=()
total=0
for unit in "${units[@]}" opencodeserver.slice; do
    path=/sys/fs/cgroup$(uctl systemctl --user show "$unit" -p ControlGroup --value)
    [[ $path == "$manager/"* ]] || die "$unit is not in the user manager: $path"
    cap=$(cat "$path/memory.max")
    [[ $cap =~ ^[0-9]+$ && $(cat "$path/memory.swap.max") == 0 ]] || die "$unit is not hard-capped with swap off"
    ((total += cap))
    if [[ $unit != opencodeserver.slice ]]; then paths+=("$path"); fi
done
physical=$(awk '/^MemTotal:/ { printf "%.0f\n", $2 * 1024 }' /proc/meminfo)
system_reserve=$((physical * 18 / 100))
parent=$(cat "$usercg/memory.max")
aggregate=$(cat "$rootcg/memory.max")
((total < parent && parent <= aggregate && aggregate + system_reserve <= physical)) ||
    die "caps=$total parent=$parent aggregate=$aggregate reserve=$system_reserve physical=$physical"
echo "ok: installed kernel budgets: family+default+server $total < user $parent <= all users $aggregate; + system reserve $system_reserve <= physical $physical bytes"

code=0
value=$(cd "$work" && uctl env HBT_SCOPE='not expanded' "$home/.local/bin/workbox-run" default -- /bin/sh -c \
    'printf "%s:%s:%s" "$PWD" "$HBT_SCOPE" "$1"; exit 27' check '${HBT_SCOPE}') || code=$?
[[ $code == 27 && $value == "$work:not expanded:"'${HBT_SCOPE}' ]] ||
    die "launcher argv, environment, cwd, stdout or exit changed: '$value' status=$code"

if ! uctl systemctl --user start opencode.service; then
    cat "$work/server.log" >&2
    die "protected server fixture did not start"
fi
until_file "$work/server"
read -r server unit < "$work/server"
server_cg=$(cg "$server")
[[ $server_cg == "$manager/opencodeserver.slice/$unit" ]] || die "server belongs to $server_cg, not the protected slice"
[[ $(uctl systemctl --user show "$unit" -p ManagedOOMPreference --value) == omit && $(cat "$server_cg/memory.min") -gt 0 ]] ||
    die "server missing its memory floor or OOM preference"
server_mem=$(cat "$server_cg/memory.current")
server_kills=$(ectl "$server_cg/memory.events" oom_kill)
parent_oom=$(ectl "$usercg/memory.events.local" oom)
since=$(date '+%F %T')

# Scale all test families temporarily to 64 MiB to make simultaneous exhaustion fast. A run's
# 96 MiB local cap is deliberately higher so the kernel OOM triggers at its family, not its leaf.
for unit in "${units[@]}"; do uctl systemctl --user set-property --runtime "$unit" MemoryMax=64M; done
(
    uctl systemd-run --user --scope --quiet --collect --unit=hbt-memory-survivor.scope --slice=personal.slice \
        sh -c 'echo $$ > "$1"; exec sleep 60' survivor "$work/survivor"
) &
survivor_job=$!
until_file "$work/survivor"
touch "$work/start-bite"
jobs=()
for family in "${families[@]}"; do
    [[ $family == bite-work ]] && continue # this one is launched from inside the protected server
    uctl "$home/.local/bin/workbox-run" "$family" --memory-max 96M -- "$home/.local/bin/opencode" hog "$family" &
    jobs+=("$!")
done
for i in "${!families[@]}"; do
    name=${families[i]}
    until_file "$work/$name.ready"
    read -r pid _ < "$work/$name.ready"
    path=$(cg "$pid")
    [[ $path == "${paths[i]}/"*.scope ]] || die "$name application is running in $path"
    [[ $(cat "$path/memory.oom.group") == 1 && $(cat "$path/memory.max") == "$((96 << 20))" && $(cat "$path/memory.swap.max") == 0 ]] ||
        die "$name did not get the per-run group kill and memory cap"
    (( $(cat "$path/memory.current") >= 24 << 20 )) || die "$name workload was not charged to its own run"
done
[[ $(cat "$server_cg/cgroup.procs") == "$server" ]] || die "workload is sharing the server's leaf"
(( $(cat "$server_cg/memory.current") - server_mem < 16 << 20 )) || die "workload memory leaked into the server's leaf"
touch "$work/hog-go"
for job in "${jobs[@]}"; do
    code=0; wait "$job" || code=$?
    ((code == 137)) || die "a run exited $code instead of being killed"
done
until_file "$work/bite-work.exit"
[[ $(cat "$work/bite-work.exit") == 137 ]] || die "the server-launched hog was not killed"
for i in "${!families[@]}"; do
    path=${paths[i]}
    [[ $(ectl "$path/memory.events.local" oom) -gt 0 && $(ectl "$path/memory.events" oom_group_kill) -gt 0 ]] ||
        die "${families[i]} did not get a family-local group OOM"
    read -r pid child < "$work/${families[i]}.ready"
    if live "$pid" || live "$child"; then die "${families[i]} left part of the killed run alive"; fi
done
survivor=$(cat "$work/survivor")
if ! live "$survivor" || ! live "$server"; then
    printf 'sibling pid %s: %s; server pid %s: %s\n' "$survivor" "$(live "$survivor" && echo alive || echo dead)" \
        "$server" "$(live "$server" && echo alive || echo dead)" >&2
    journalctl -k -b --since="$since" --no-pager -o cat >&2
    journalctl -u systemd-oomd.service -b --since="$since" --no-pager -o cat >&2
    die "a sibling run/server was killed"
fi
[[ $(ectl "$server_cg/memory.events" oom_kill) == "$server_kills" && $(ectl "$usercg/memory.events.local" oom) == "$parent_oom" ]] ||
    die "a kill escaped its family"
echo "ok: five simultaneous family OOMs (including app.slice default), each kills the entire two-process run; sibling survived; server-launched hog charged only to its run; server received zero kills"

touch "$work/server-grow"
new=$server
for _ in $(seq 1 150); do
    read -r new unit < "$work/server"
    if [[ $new != "$server" ]] && live "$new"; then break; fi
    sleep 0.2
done
[[ $new != "$server" && $(cg "$new") == "$manager/opencodeserver.slice/"* ]] || die "watchdog did not recover a server after its own cap"
if live "$server"; then die "old server was not killed by its cap"; fi
live "$(cat "$work/survivor")" || die "server OOM killed a sibling run"
if journalctl -k -b --since="$since" --no-pager -o cat | grep -E 'global_oom|CONSTRAINT_NONE|^Out of memory: Killed process'; then
    die "global OOM during workbox containment test"
fi
uctl systemctl --user stop hbt-memory-survivor.scope
wait "$survivor_job" || true
uctl systemctl --user stop opencode.service
if uctl systemctl --user is-active --quiet workbox-opencode-watch.timer; then die "explicit stop left the recovery timer active"; fi
echo "ok: server exceeded its own cap and restarted cleanly ($server -> $new); explicit stop stopped recovery; sibling and host survived, no global OOM"
