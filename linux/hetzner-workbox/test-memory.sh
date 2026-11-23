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
    systemctl stop "$server_unit" >/dev/null 2>&1 || true
    rm -f -- "/run/systemd/system.control/$server_unit.d/50-MemoryMax.conf" \
        "/run/systemd/system.control/user-$uid.slice.d/50-MemoryMax.conf"
    systemctl daemon-reload
    uctl systemctl --user stop hbt-memory-survivor.scope hbt-unnamed.scope hbt-transient.service hbt-linger.service hbt-inventory.timer >/dev/null 2>&1 || true
    if [[ -n ${container_image:-} ]]; then docker rm -f hbt-docker >/dev/null 2>&1 || true; docker rmi "$container_image" >/dev/null 2>&1 || true; fi
    if [[ -n ${ssh_job:-} ]]; then kill "$ssh_job" 2>/dev/null || true; fi
    if [[ -S $work/tmux.sock ]]; then uctl tmux -S "$work/tmux.sock" kill-server || true; fi
}
server_unit="workbox-opencode@$user.service"
trap cleanup EXIT
uctl install -m 0755 "$box/bin/workbox-run" "$home/.local/bin/"
uctl install -m 0755 "$here/test-memory-fixture.py" "$home/.local/bin/opencode"
uctl systemctl --user daemon-reload
units=(opencode.slice ergo.slice bite-work.slice personal.slice app.slice)
families=(opencode ergo bite-work personal default)
uctl systemctl --user start "${units[@]}"
paths=()
total=0
for unit in "${units[@]}"; do
    path=/sys/fs/cgroup$(uctl systemctl --user show "$unit" -p ControlGroup --value)
    [[ $path == "$manager/"* ]] || die "$unit is not in the user manager: $path"
    cap=$(cat "$path/memory.max")
    [[ $cap =~ ^[0-9]+$ && $(cat "$path/memory.swap.max") == 0 ]] || die "$unit is not hard-capped with swap off"
    ((total += cap))
    paths+=("$path")
done
physical=$(awk '/^MemTotal:/ { printf "%.0f\n", $2 * 1024 }' /proc/meminfo)
system_reserve=$((physical * 18 / 100))
parent=$(cat "$usercg/memory.max")
aggregate=$(cat "$rootcg/memory.max")
[[ $(cat "$rootcg/memory.swap.max") == 0 && $(cat "$usercg/memory.swap.max") == 0 ]] || die 'workload parent can swap'

code=0
value=$(cd "$work" && uctl env HBT_SCOPE='not expanded' "$home/.local/bin/workbox-run" default -- /bin/sh -c \
    'printf "%s:%s:%s" "$PWD" "$HBT_SCOPE" "$1"; exit 27' check '${HBT_SCOPE}') || code=$?
[[ $code == 27 && $value == "$work:not expanded:"'${HBT_SCOPE}' ]] ||
    die "launcher argv, environment, cwd, stdout or exit changed: '$value' status=$code"

if ! systemctl start "$server_unit"; then
    journalctl -u "$server_unit" -b -n 30 --no-pager >&2
    die "protected server fixture did not start"
fi
until_file "$work/server"
read -r server unit < "$work/server"
server_cg=$(cg "$server")
protected=/sys/fs/cgroup/workboxprotected.slice
[[ $server_cg == "$protected/$unit" ]] || die "server belongs to $server_cg, not the protected slice"
[[ $(systemctl show "$unit" -p ManagedOOMPreference --value) == omit && $(cat "$server_cg/memory.min") -gt 0 ]] ||
    die "server missing its memory floor or OOM preference"
reservation=$(cat "$protected/memory.max")
((total < parent && parent <= aggregate && aggregate + reservation + system_reserve <= physical)) ||
    die "caps=$total parent=$parent aggregate=$aggregate server=$reservation reserve=$system_reserve physical=$physical"
echo "ok: installed kernel budgets: family+default $total < account $parent <= workload $aggregate; + server $reservation + system reserve $system_reserve <= physical $physical bytes"
inventory_flags=()
if [[ -n ${HB_TEST_SCRATCH:-} ]] && command -v dockerd >/dev/null; then inventory_flags+=(--docker); fi
inventory() { python3 "$here/test-cgroup-inventory.py" "$uid" "$server" "${inventory_flags[@]}" "$@"; }
inventory
server_mem=$(cat "$server_cg/memory.current")
server_kills=$(ectl "$server_cg/memory.events" oom_kill)
since=$(date '+%F %T')

# Scale all test families temporarily to 64 MiB to make simultaneous exhaustion fast. A run's
# 96 MiB local cap is deliberately higher so the kernel OOM triggers at its family, not its leaf.
for unit in "${units[@]}"; do uctl systemctl --user set-property --runtime "$unit" MemoryMax=64M; done
(
    uctl systemd-run --user --scope --quiet --collect --expand-environment=no --unit=hbt-memory-survivor.scope --slice=personal.slice \
        sh -c 'echo $$ > "$1"; exec sleep 180' survivor "$work/survivor"
) &
survivor_job=$!
until_file "$work/survivor"
survivor=$(cat "$work/survivor")
[[ $survivor =~ ^[1-9][0-9]*$ ]] && live "$survivor" || die "fixture did not report a live numeric survivor PID"
jobs=()
for family in "${families[@]}"; do
    [[ $family == bite-work ]] && continue # this one is launched from inside the protected server
    uctl "$home/.local/bin/workbox-run" "$family" --memory-max 96M -- "$home/.local/bin/opencode" hog "$family" &
    jobs+=("$!")
done
if [[ -n ${HB_TEST_SSH_KEY:-} ]]; then
    # The SSH connection is a genuine PAM/logind session, not runuser.
    tmux_start=
    if command -v tmux >/dev/null; then
        tmux_start="tmux -f /dev/null -S '$work/tmux.sock' new-session -d 'sleep 160' &&
            tmux -S '$work/tmux.sock' display-message -p '#{pid}' > '$work/tmux.pid';"
    else
        echo 'unproven: command -v tmux returned 1 (not installed)'
    fi
    ssh -n -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o IdentitiesOnly=yes -i "$HB_TEST_SSH_KEY" -p 22199 "$user@127.0.0.1" \
        "$tmux_start echo \$\$ > '$work/ssh.pid'; exec sleep 160" &
    ssh_job=$!
    until_file "$work/ssh.pid"
fi
pid_command='echo $$ > "$1"; exec sleep 120'
uctl systemd-run --user --quiet --unit=hbt-transient --collect --slice=unnamed.slice \
    --expand-environment=no sh -c "$pid_command" transient "$work/transient.pid"
uctl systemd-run --user --quiet --unit=hbt-inventory --on-active=1s --timer-property=AccuracySec=1s --collect --slice=unnamed.slice \
    --expand-environment=no sh -c "$pid_command" timer "$work/timer.pid"
# Start a disk-backed unit through a lingering manager with no session association.
printf '[Service]\nExecStart=/usr/bin/sleep 120\n' | uctl tee "$home/.config/systemd/user/hbt-linger.service" >/dev/null
uctl systemctl --user daemon-reload
uctl systemctl --user start hbt-linger.service
uctl systemctl --user show hbt-linger.service -p MainPID --value > "$work/linger.pid"
(
    uctl systemd-run --user --scope --quiet --collect --unit=hbt-unnamed --slice=unnamed.slice \
        --expand-environment=no --property=OOMPolicy=kill -- \
        "$home/.local/bin/opencode" hog unnamed
) &
unnamed_job=$!
until_file "$work/unnamed.ready"
read -r unnamed unnamed_child < "$work/unnamed.ready"
unnamed_cg=$(cg "$unnamed")
[[ $(cat "$unnamed_cg/memory.max") == max && $(cat "$(dirname "$unnamed_cg")/memory.max") == max ]] ||
    die "unnamed scope failed to exercise fallback"
pids=("$unnamed" "$unnamed_child" "$survivor")
for kind in transient timer linger; do until_file "$work/$kind.pid"; pids+=("$(cat "$work/$kind.pid")"); done
if [[ -n ${HB_TEST_SSH_KEY:-} ]]; then
    pids+=("$(cat "$work/ssh.pid")")
    if [[ -n $tmux_start ]]; then until_file "$work/tmux.pid"; pids+=("$(cat "$work/tmux.pid")"); fi
fi
if [[ -n ${HB_TEST_SCRATCH:-} ]]; then
    jobs_cg=$rootcg/user-jobs.slice
    jobs_pid() {
        local label=$1 pid=$2 path
        [[ $pid =~ ^[1-9][0-9]*$ ]] && live "$pid" || die "$label did not start"
        path=$(cg "$pid")
        printf 'jobs inventory: %s (PID %s) %s; child cap=%s bytes\n' "$label" "$pid" "$path" "$(cat "$jobs_cg/memory.max")"
        [[ $path == "$jobs_cg/"* ]] || die "$label is outside user-jobs.slice: $path"
        pids+=("$pid")
    }
    if [[ ${HB_TEST_REQUIRE_JOBS:-} == with-jobs* ]]; then
        for kind in cron at dockerd; do command -v "$kind" >/dev/null || die "fixture requires $kind"; done
    fi
    for kind in cron at; do
        if ! command -v "$kind" >/dev/null; then echo "unproven: command -v $kind returned 1 (not installed)"; continue; fi
        printf '#!/bin/sh\necho $$ > "%s/%s.pid"\nexec sleep 180\n' "$work" "$kind" > "$work/job-$kind"
        chmod 755 "$work/job-$kind"
        if [[ $kind == cron ]]; then
            printf '* * * * * %s\n' "$work/job-$kind" | uctl crontab -
        else
            # at replays its submission cwd; use the readable guest fixture,
            # not the caller's macOS checkout path.
            job=$(cd "$work"; printf '%s\n' "$work/job-$kind" | uctl env SHELL=/bin/sh at now 2>&1)
            sed -nE 's/^job ([0-9]+).*/\1/p' <<<"$job" > "$HB_TEST_SCRATCH/at-job"
        fi
    done
    for kind in cron at; do
        [[ -e $work/job-$kind ]] || continue
        for _ in {1..80}; do [[ -s $work/$kind.pid ]] && break; sleep 1; done
        until_file "$work/$kind.pid"
        jobs_pid "$kind job" "$(cat "$work/$kind.pid")"
    done
    [[ ! -e $work/job-cron ]] || uctl crontab -r
    if command -v dockerd >/dev/null; then
        # Launch Docker via the ordinary account's Docker group, not sudo.
        driver=$(uctl docker info --format '{{.CgroupDriver}}/{{.CgroupVersion}}')
        [[ $driver == systemd/2 ]] || die "expected Docker systemd/cgroup v2, got $driver"
        printf 'Docker: cgroup driver/version = %s\n' "$driver"
        jobs_pid dockerd "$(systemctl show docker.service -p MainPID --value)"
        jobs_pid containerd "$(systemctl show containerd.service -p MainPID --value)"
        install -d "$work/container"
        for part in bin lib lib64 sbin; do
            [[ ! -L /$part ]] || ln -s "$(readlink "/$part")" "$work/container/$part"
        done
        container_image=$(tar -C "$work/container" -c . | uctl docker import -)
        uctl docker run --name=hbt-docker --network=none --volume=/usr:/usr:ro --volume="$work:$work" \
            --volume="$home:$home:ro" --env="HOME=$home" "$container_image" \
            /usr/bin/python3 "$home/.local/bin/opencode" hog docker &
        docker_job=$!
        until_file "$work/docker.ready"
        docker_pid=$(uctl docker inspect --format '{{.State.Pid}}' hbt-docker)
        jobs_pid 'default container' "$docker_pid"
        docker_cg=$(cg "$docker_pid")
        container_id=$(uctl docker inspect --format '{{.Id}}' hbt-docker)
        shims=$(ps -eo pid=,comm=,args= | awk -v id="$container_id" '$2 ~ /^containerd-shim/ && index($0, " -id " id) { print $1 }')
        [[ -n $shims ]] || die "cannot find live shim for $container_id"
        for shim in $shims; do jobs_pid 'containerd-shim' "$shim"; done
        jobs_cap=$(cat "$jobs_cg/memory.max")
        expected_cap=$((physical * 36 / 100))
        [[ $(cat "$jobs_cg/memory.swap.max") == 0 && $(cat "$docker_cg/memory.max") == max ]] &&
            ((jobs_cap <= expected_cap && jobs_cap >= expected_cap - 1048576 && jobs_cap < 1400 * 1048576)) ||
            die "container is not exercising the installed, unswappable 36% cap on this bounded guest"
        jobs_oom=$(ectl "$jobs_cg/memory.events.local" oom)
        jobs_kills=$(ectl "$jobs_cg/memory.events" oom_kill)
        workload_oom=$(ectl "$rootcg/memory.events.local" oom)
        printf 'Docker: container limit is inherited from %s (%s bytes, 36%%); workload cap %s bytes\n' "$jobs_cg" "$jobs_cap" "$aggregate"
    else
        echo 'unproven: command -v dockerd returned 1 (Docker not installed)'
    fi
fi
inventory "${pids[@]}"
touch "$work/start-bite"
for i in "${!families[@]}"; do
    name=${families[i]}
    until_file "$work/$name.ready"
    read -r pid _ < "$work/$name.ready"
    path=$(cg "$pid")
    if [[ $name == bite-work ]]; then
        [[ $path == "${paths[i]}/"*.service ]] || die "$name application is running in $path"
    else
        [[ $path == "${paths[i]}/"*.scope ]] || die "$name application is running in $path"
    fi
    [[ $(cat "$path/memory.oom.group") == 1 && $(cat "$path/memory.max") == "$((96 << 20))" && $(cat "$path/memory.swap.max") == 0 ]] ||
        die "$name did not get the per-run group kill and memory cap"
    (( $(cat "$path/memory.current") >= 24 << 20 )) || die "$name workload was not charged to its own run"
done
until_file "$work/broker"
broker=$(cat "$work/broker")
while read -r pid; do
    [[ $pid == "$server" || $pid == "$broker" ]] || die "unexpected process $pid in the server leaf"
done < "$server_cg/cgroup.procs"
(( $(cat "$server_cg/memory.current") - server_mem < 16 << 20 )) || die "workload memory leaked into the server's leaf"
# Give the unnamed run the inherited account backstop; stagger its growth so
# the families can hit their own 64 MiB limits before it consumes the remainder.
systemctl set-property --runtime "user-$uid.slice" MemoryMax=512M
parent_oom=$(ectl "$usercg/memory.events.local" oom)
touch "$work/hog-go"
for job in "${jobs[@]}"; do
    code=0; wait "$job" || code=$?
    ((code == 137)) || die "a run exited $code instead of being killed"
done
until_file "$work/bite-work.exit"
code=$(cat "$work/bite-work.exit")
# systemd 255 reports generic failure for a signaled transient service;
# kernel events and both dead PIDs below independently prove the group kill.
[[ $code == 137 || $code == 1 ]] || die "the server-launched service unexpectedly returned $code"
printf 'server-launched workload: transient service returned %s\n' "$code"
for i in "${!families[@]}"; do
    path=${paths[i]}
    [[ $(ectl "$path/memory.events.local" oom) -gt 0 && $(ectl "$path/memory.events" oom_group_kill) -gt 0 ]] ||
        die "${families[i]} did not get a family-local group OOM"
    read -r pid child < "$work/${families[i]}.ready"
    if live "$pid" || live "$child"; then die "${families[i]} left part of the killed run alive"; fi
done
if ! live "$survivor" || ! live "$server"; then
    printf 'sibling pid %s: %s; server pid %s: %s\n' "$survivor" "$(live "$survivor" && echo alive || echo dead)" \
        "$server" "$(live "$server" && echo alive || echo dead)" >&2
    journalctl -k -b --since="$since" --no-pager -o cat >&2
    journalctl -u systemd-oomd.service -b --since="$since" --no-pager -o cat >&2
    die "a sibling run/server was killed"
fi
code=0; wait "$unnamed_job" || code=$?
((code == 137)) && [[ $(ectl "$usercg/memory.events.local" oom) -gt $parent_oom ]] ||
    die "unnamed run did not hit its workload backstop (exit $code)"
if live "$unnamed" || live "$unnamed_child"; then die "unnamed scope was not killed as a group"; fi
if [[ -n ${docker_job:-} ]]; then
    code=0; wait "$docker_job" || code=$?
    jobs_oom_after=$(ectl "$jobs_cg/memory.events.local" oom)
    jobs_kills_after=$(ectl "$jobs_cg/memory.events" oom_kill)
    workload_oom_after=$(ectl "$rootcg/memory.events.local" oom)
    ((code == 137 && jobs_oom_after > jobs_oom && jobs_kills_after > jobs_kills && workload_oom_after == workload_oom)) ||
        die "Docker did not hit only the jobs backstop (exit $code, jobs OOM $jobs_oom->$jobs_oom_after, kills $jobs_kills->$jobs_kills_after, parent OOM $workload_oom->$workload_oom_after)"
    printf 'Docker: exit=%s, 36%%-child local oom %s→%s, subtree oom_kill %s→%s, workload parent local oom %s→%s; State.OOMKilled=%s\n' \
        "$code" "$jobs_oom" "$jobs_oom_after" "$jobs_kills" "$jobs_kills_after" "$workload_oom" "$workload_oom_after" \
        "$(uctl docker inspect --format '{{.State.OOMKilled}}' hbt-docker)"
fi
live "$survivor" && live "$server" && [[ $(ectl "$server_cg/memory.events" oom_kill) == "$server_kills" ]] ||
    die "an unnamed or container kill escaped its workload branch"
echo "ok: all family, unnamed and available container hogs released together; whole runs killed, default backstop fired, protected server and sibling survived"

systemctl set-property --runtime "$server_unit" MemoryMax=64M
touch "$work/server-grow"
new=$server
for _ in $(seq 1 150); do
    read -r new unit < "$work/server"
    if [[ $new != "$server" ]] && live "$new"; then break; fi
    sleep 0.2
done
[[ $new != "$server" && $(cg "$new") == "$protected/"* ]] || die "systemd did not recover a server after its own cap"
if live "$server"; then die "old server was not killed by its cap"; fi
live "$survivor" || die "server OOM killed a sibling run"
if journalctl -k -b --since="$since" --no-pager -o cat | grep -E 'global_oom|CONSTRAINT_NONE|^Out of memory: Killed process'; then
    die "global OOM during workbox containment test"
fi
uctl systemctl --user stop hbt-memory-survivor.scope
wait "$survivor_job" || true
systemctl stop "$server_unit"
if systemctl is-active --quiet "$server_unit"; then die "explicit stop left the server active"; fi
echo "ok: server exceeded its own cap and restarted cleanly ($server -> $new); explicit stop stopped recovery; sibling and host survived, no global OOM"
