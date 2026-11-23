#!/usr/bin/env bash
# Run inside the selected, disposable VM. Negative probes must refuse before
# changes to the host or the fixture; the fleet has a separately tested legacy mode.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
box=$here/../../workbox
# shellcheck source=../../workbox/host-identity.sh
. "$box/host-identity.sh"
workbox_require_host
[[ $(id -u) == 0 ]] || exit 2
root=$(mktemp -d /var/tmp/hetzner-identity-test.XXXXXXXX)
[[ $root =~ ^/var/tmp/hetzner-identity-test\.[a-zA-Z0-9]{8}$ ]] || exit 2
enrolled=/etc/hetzner-workbox/host-identity.env
[[ ! -e $enrolled ]] || { echo 'fixture requires an unenrolled VM' >&2; exit 2; }
cleanup() {
    rm -f -- "$enrolled"
    rmdir -- "$(dirname "$enrolled")" 2>/dev/null || true
    rm -r -- "$root"
}
trap cleanup EXIT
mkdir -p "$root"/{target/etc,home,tmp,fixture/bin} "$(dirname "$enrolled")"
export HB_TARGET=$root/target HB_ETC=$root/target/etc HB_HOME=$root/home HOME=$root/home TMPDIR=$root/tmp
cp "$box"/{host-identity.sh,install-bin.sh} "$root/fixture/"
printf 'true\n' > "$root/fixture/zshenv"
printf 'true\n' > "$root/fixture/zshrc"
printf '#!/bin/sh\nexit 0\n' > "$root/fixture/bin/apply-agent-settings"
chmod +x "$root/fixture/bin/apply-agent-settings"
wrong=11111111111111111111111111111111
if [[ $wrong == "$WORKBOX_EXPECT_MACHINE_ID" ]]; then wrong=22222222222222222222222222222222; fi

# Compare metadata (including device, owner, mode, timestamps and mount table)
# as well as ordinary file bytes. Fixture stdout/stderr stays in memory.
snapshot() {
    find "$root" /etc /usr/local/etc /usr/local/libexec -xdev \
        -printf '%p|%y|%m|%u|%g|%i|%s|%T@|%C@|%l\n' 2>/dev/null | sort || true
    find "$root" /etc -xdev -type f ! -name 'opencode.db*' -print0 | sort -z | xargs -0 -r sha256sum
    cat /proc/self/mountinfo
}
unchanged_refusal() {
    local before after mode=$1 rc=0 output
    shift
    before=$(snapshot)
    if [[ $mode == none ]]; then
        output=$(env -u WORKBOX_EXPECT_MACHINE_ID "$@" 2>&1) || rc=$?
    else
        output=$(env WORKBOX_EXPECT_MACHINE_ID="$wrong" "$@" 2>&1) || rc=$?
    fi
    [[ $rc == 78 && $output == *'intended-host identity refused'* ]] ||
        { printf 'FAIL %s %s: exit %s: %s\n' "$mode" "$*" "$rc" "$output" >&2; exit 1; }
    after=$(snapshot)
    diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after")
    printf 'ok: %s, %s: refusal %s, unchanged snapshot\n' "$mode" "${*//"$here/"/}" "$rc"
}
for mode in none wrong; do
    for phase in host user keys packages tools storage firewall rootssh tailscale sshd reserve upgrades sysctl backup bootstrap; do
        unchanged_refusal "$mode" bash "$here/provision.sh" "$phase"
    done
    unchanged_refusal "$mode" sh "$box/bootstrap.sh"
    unchanged_refusal "$mode" sh "$box/system-tools.sh" reserve slices
    unchanged_refusal "$mode" sh "$root/fixture/install-bin.sh"
    unchanged_refusal "$mode" sh "$box/bin/workbox-rift-storage" --apply
    unchanged_refusal "$mode" sh "$box/bin/workbox-rift-storage" --fstab
    unchanged_refusal "$mode" sh "$box/bin/install-node"
    unchanged_refusal "$mode" bash "$here/layout.sh"
    for action in enable apply; do unchanged_refusal "$mode" bash "$here/storage.sh" "$action"; done
    for action in install run list 'restore test'; do
        # shellcheck disable=SC2086 # literal fixture args
        unchanged_refusal "$mode" bash "$here/backup.sh" $action "$root/target"
    done
    for action in 'pass 1' 'rest' 'activate 1' 'runs --yes' 'remote /home/exedev locate'; do
        # shellcheck disable=SC2086 # literal fixture args
        unchanged_refusal "$mode" bash "$here/sync.sh" $action
    done
    unchanged_refusal "$mode" bash "$here/check.sh"
    unchanged_refusal "$mode" bash "$here/installimage-check.sh" "$root/fixture"
done

# A correct local machine is not authority to write to an unintended peer.
# SSH is the outside boundary: the stub accepts only the identity read.
mkdir "$root/bin"
printf '#!/bin/bash\n[[ ${*: -2} == "cat /etc/machine-id" ]] || exit 99\nprintf "%%s\\n" "$PEER_MACHINE_ID"\n' > "$root/bin/ssh"
chmod 755 "$root/bin/ssh"
remote_before=$(snapshot)
for peer in '' "$wrong"; do
    rc=0
    output=$(PATH="$root/bin:$PATH" HB_TO=test@unrelated HB_TARGET_MACHINE_ID="$peer" \
        PEER_MACHINE_ID="$WORKBOX_EXPECT_MACHINE_ID" bash "$here/sync.sh" rest 2>&1) || rc=$?
    [[ $rc == 78 && $output == *'intended-host identity refused'* ]]
    after=$(snapshot)
    diff -u <(printf '%s\n' "$remote_before") <(printf '%s\n' "$after")
done
echo 'ok: missing and mismatched destination pin, local host matches; no SSH operation beyond identity read, unchanged snapshot'

env -u WORKBOX_EXPECT_MACHINE_ID sh "$root/fixture/install-bin.sh" --apply
test -x "$HOME/.local/bin/apply-agent-settings"
echo 'ok: unenrolled fleet --apply installed its command with no explicit identity'
printf 'WORKBOX_EXPECT_MACHINE_ID=%s\n' "$WORKBOX_EXPECT_MACHINE_ID" > "$enrolled"
env -u WORKBOX_EXPECT_MACHINE_ID sh "$root/fixture/install-bin.sh" --apply
echo 'ok: enrolled fleet --apply matched the root-enrolled identity'
unchanged_refusal wrong sh "$root/fixture/install-bin.sh" --apply
printf 'WORKBOX_EXPECT_MACHINE_ID=%s\n' "$wrong" > "$enrolled"
unchanged_refusal none sh "$root/fixture/install-bin.sh" --apply
echo 'HOST IDENTITY OK'
