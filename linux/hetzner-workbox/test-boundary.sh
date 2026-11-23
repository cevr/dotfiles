#!/usr/bin/env bash
# Targeted Linux VM leg. It exercises the actual provisioned system units without
# touching the layout, quotas or durable data that the previous round proved.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
box=$here/../../workbox
# shellcheck source=../../workbox/host-identity.sh
. "$box/host-identity.sh"
workbox_require_host
[[ $(id -u) == 0 && ! -e /etc/hetzner-workbox/host-identity.env ]] || exit 2
name=hbtest
uid=1990
if [[ ${1:-} == --cleanup-interrupted ]]; then
    old_home=$(getent passwd "$name" | cut -d: -f6 || true)
    [[ -n $old_home ]] || exit 0
    [[ $(id -u "$name") == "$uid" && $old_home =~ ^/var/tmp/hetzner-workbox-test\.[a-zA-Z0-9]{8}/target/home/hbtest$ ]] || exit 2
    loginctl disable-linger "$name"
    loginctl terminate-user "$name" || true
    pkill -KILL -u "$uid" || true
    userdel "$name"
    exit 0
fi
! getent passwd "$name" >/dev/null && ! getent passwd "$uid" >/dev/null
work=$(mktemp -d /var/tmp/hetzner-workbox-test.XXXXXXXX)
[[ $work =~ ^/var/tmp/hetzner-workbox-test\.[a-zA-Z0-9]{8}$ ]] || exit 2
chmod 755 "$work"
home=$work/target/home/$name
owned_units=(
    /etc/systemd/system/{workboxprotected.slice,workbox-opencode@.service,user-jobs.slice}
    /etc/systemd/system/{cron,atd}.service.d/40-workbox-workload.conf
    /etc/systemd/system/{user.slice,system.slice}.d/40-workbox-slices.conf
    /etc/systemd/system/user-.slice.d/20-workbox-memory-limit.conf
    /etc/systemd/system/user@.service.d/40-workbox-delegate.conf
    /etc/systemd/user/{ergo,opencode,bite-work,personal}.slice
    /etc/systemd/user/app.slice.d/30-workbox-reserve.conf
    /usr/local/libexec/workbox-opencode-server
)
for f in "${owned_units[@]}"; do [[ ! -e $f ]] || { echo "fixture would overwrite $f" >&2; exit 2; }; done
cleanup() {
    local code=$?
    set +e
    systemctl stop "workbox-opencode@$name.service" hbt-boundary-sshd.service
    if command -v crontab >/dev/null; then crontab -u "$name" -r 2>/dev/null; fi
    if [[ -f $work/at-job ]]; then atrm "$(cat "$work/at-job")" 2>/dev/null; fi
    loginctl disable-linger "$name"
    loginctl terminate-user "$name"
    systemctl stop "user-$uid.slice" workboxprotected.slice
    pkill -KILL -u "$uid" || true
    for _ in {1..20}; do
        if userdel "$name"; then break; fi
        sleep 0.1
    done
    if getent passwd "$name" >/dev/null; then echo 'fixture user was not removed' >&2; code=1; fi
    rm -f -- "${owned_units[@]}"
    if [[ -e $work/docker-before ]]; then
        cp -a "$work/docker-before" /etc/docker/daemon.json
    elif [[ -e $work/docker-absent ]]; then
        rm -f /etc/docker/daemon.json
    fi
    systemctl daemon-reload
    for job in cron atd docker; do
        if [[ -e $work/was-active-$job ]]; then systemctl restart "$job.service"; else systemctl stop "$job.service" 2>/dev/null; fi
    done
    rm -r -- "$work"
    exit "$code"
}
trap cleanup EXIT
install -d -m 0755 "$(dirname "$home")"
useradd -U -u "$uid" -m -d "$home" -s /bin/bash "$name"
# No password login, but sshd must not reject the entire test account.
usermod -p '*' "$name"
for job in cron atd docker; do
    if systemctl is-active --quiet "$job.service"; then touch "$work/was-active-$job"; fi
done
if command -v dockerd >/dev/null; then
    if [[ -e /etc/docker/daemon.json ]]; then cp -a /etc/docker/daemon.json "$work/docker-before"; else touch "$work/docker-absent"; fi
fi
bash "$here/provision.sh" reserve
loginctl enable-linger "$name"
for _ in {1..100}; do
    [[ -S /run/user/$uid/bus ]] && break
    sleep 0.1
done
runuser -u "$name" -- install -d -m 0700 "$home/.ssh"
ssh-keygen -q -t ed25519 -N '' -f "$work/key"
install -m 0600 -o "$uid" -g "$uid" "$work/key.pub" "$home/.ssh/authorized_keys"
ssh-keygen -q -t ed25519 -N '' -f "$work/sshd-key"
install -d -m 0755 /run/sshd
systemd-run --quiet --collect --unit=hbt-boundary-sshd /usr/sbin/sshd -D -e -f /dev/null \
    -h "$work/sshd-key" -o ListenAddress=127.0.0.1 -p 22199 -o UsePAM=yes \
    -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o AllowUsers="$name"
for _ in {1..100}; do
    [[ -n $(ss -H -lnt 'sport = :22199') ]] && break
    sleep 0.05
done
export HB_TEST_SSH_KEY=$work/key
export HB_TEST_SCRATCH=$work
bash "$here/test-memory.sh" "$work/memory" "$name" "$uid"
echo 'BOUNDARY OK'
