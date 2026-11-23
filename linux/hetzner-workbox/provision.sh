#!/usr/bin/env bash
# Provisions the Hetzner workbox's system layer, as root, after layout.sh.
# Idempotent: every phase checks before it changes, so a rerun is safe.
#
# Usage: sudo [TS_AUTHKEY=...] provision.sh [phase...]
# Phases, in order (default: all):
#   host       hostname bite-cristian
#   user       exedev, uid 1000, the home and /workspaces owned by it, sudo
#              without a password (as on exe.dev), linger
#   keys       the Mac key and the herdr-mobile key (authorized_keys here),
#              plus HB_EXTRA_KEYS (one key per line: sync.sh's key)
#   packages   the exe box's base: apt repos for Tailscale, MongoDB 8.0 and gh,
#              then HB_PACKAGES
#   firewall   firewall.nft at boot: only Tailscale, ICMP and ssh 22 come in
#   rootssh    the stock sshd on 22: keys only, no passwords
#   tailscale  `tailscale up` with TS_AUTHKEY from the environment (read from
#              stdin by tailscale, never stored, never on a command line), as
#              HB_TS_NAME (default bite-cristian-hel until the cutover)
#   sshd       workbox/systemd/system/bite-workbox-sshd on the Tailscale IPv4
#              (or HB_SSH_LISTEN), port 2222, AllowUsers exedev
#   tools      workbox/system-tools.sh: btrfs-progs with simple quotas, fish, ksh,
#              mksh, qemu-user-static and its binfmt entry, Go and PowerShell as
#              workbox/pins.conf pins them, /tmp's rules and the held-file guard,
#              the free-space figures (the same script bootstrap.sh runs)
#   storage    storage.sh: the limited subvolumes of storage.conf (/tmp, the caches),
#              and hetzner-workbox-storage.service, which applies them at each boot
#   upgrades   unattended-upgrades with workbox's 20auto-upgrades
#   reserve    workbox/system-tools.sh reserve slices: the OpenCode service's memory
#              floor, the run families' slices (workbox/slices.conf)
#              (bite.slice's CPU and IO weights come with the sshd phase)
#   sysctl     workbox's sysctl.d/90-inotify.conf (the inotify limits the lab's
#              standby keepers need), applied with sysctl -p
#   backup     backup.sh install (btrbk, nightly, to the Storage Box)
#   bootstrap  workbox/bootstrap.sh as exedev, once the home holds the dotfiles
#              (after sync.sh activate); before that it says what comes next
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

HB_TS_NAME=${HB_TS_NAME:-bite-cristian-hel}
HB_APT_REPOS=${HB_APT_REPOS:-1}
HB_SSH_LISTEN=${HB_SSH_LISTEN:-}
HB_SSH_PORT=${HB_SSH_PORT:-2222}
HB_PACKAGES=${HB_PACKAGES:-"btrfs-progs btrbk mdadm rsync mbuffer zstd pv sshfs jq curl git zsh mosh tmux \
ripgrep fd-find htop btop ncdu lsof unzip build-essential ffmpeg ghostscript sqlite3 nftables \
redis-server syncthing docker.io docker-compose-v2 docker-buildx nodejs python3-pip nginx \
unattended-upgrades systemd-resolved mongodb-org gh tailscale"}
system_dir=$hb_dotfiles/workbox/systemd/system
etc=${HB_ETC:-/etc}
phases=(host user keys packages tools storage firewall rootssh tailscale sshd reserve upgrades sysctl backup bootstrap)

need_root
[[ $# -gt 0 ]] && phases=("$@")

# Bounded network time; NEEDRESTART_SUSPEND keeps Ubuntu's needrestart hook from restarting services.
apt_bounds=(-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3)
apt_install() { NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive apt-get "${apt_bounds[@]}" install -y -q "$@" >/dev/null; }
# Installs a file only when it differs; prints whether it changed.
put() { # mode src dest
    if [[ -e $3 ]] && cmp -s "$2" "$3"; then return 1; fi
    install -D -m "$1" "$2" "$3"
    say "installed $3"
}

phase_host() {
    [[ $(hostname) == "$HB_HOSTNAME" ]] && { say "ok: hostname $HB_HOSTNAME"; return; }
    hostnamectl set-hostname "$HB_HOSTNAME"
    say "hostname $HB_HOSTNAME"
}

phase_user() {
    if id "$HB_USER" >/dev/null 2>&1; then
        [[ $(id -u "$HB_USER") == "$HB_UID" ]] || die "$HB_USER exists with uid $(id -u "$HB_USER"), not $HB_UID"
    else
        local other
        other=$(getent passwd "$HB_UID" | cut -d: -f1 || true)
        [[ -z $other ]] || die "uid $HB_UID belongs to $other"
        # The home is the @home subvolume, already mounted: no -m, no skeleton.
        useradd -u "$HB_UID" -U -d "$HB_HOME" -s /bin/bash "$HB_USER"
        say "user $HB_USER ($HB_UID)"
    fi
    local g
    for g in sudo adm docker; do
        getent group "$g" >/dev/null && usermod -a -G "$g" "$HB_USER"
    done
    [[ -d $HB_HOME ]] || install -d "$HB_HOME"
    chown "$HB_USER:$HB_USER" "$HB_HOME"
    chmod 750 "$HB_HOME"
    install -d -o "$HB_USER" -g "$HB_USER" -m 755 "$HB_WORKSPACES"
    chown "$HB_USER:$HB_USER" "$HB_WORKSPACES"
    local s
    s=$(mktemp)
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$HB_USER" > "$s"
    visudo -cqf "$s" || die "sudoers line did not parse"
    put 0440 "$s" "$etc/sudoers.d/90-$HB_USER" || say "ok: sudo for $HB_USER"
    rm -f "$s"
    loginctl enable-linger "$HB_USER"
}

phase_keys() {
    local ssh_dir=$HB_HOME/.ssh file=$HB_HOME/.ssh/authorized_keys key added=0
    install -d -o "$HB_USER" -g "$HB_USER" -m 700 "$ssh_dir"
    touch "$file"
    while IFS= read -r key; do
        [[ -z $key || $key == \#* ]] && continue
        # Match on the key itself, not its comment.
        grep -qF "$(awk '{ print $2 }' <<<"$key")" "$file" && continue
        printf '%s\n' "$key" >> "$file"
        added=$((added + 1))
    done < <(cat "$hb_dir/authorized_keys"; printf '%s\n' "${HB_EXTRA_KEYS:-}")
    chown "$HB_USER:$HB_USER" "$file"
    chmod 600 "$file"
    say "authorized_keys: $added added, $(grep -c . "$file") in all"
}

phase_packages() {
    if ((HB_APT_REPOS)); then
        local arch codename
        arch=$(dpkg --print-architecture)
        codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
        install -d -m 755 /etc/apt/keyrings
        if [[ ! -e /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
            curl -fsSL --connect-timeout 20 --max-time 300 --retry 3 "https://pkgs.tailscale.com/stable/ubuntu/$codename.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
            curl -fsSL --connect-timeout 20 --max-time 300 --retry 3 "https://pkgs.tailscale.com/stable/ubuntu/$codename.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
        fi
        if [[ ! -e /usr/share/keyrings/mongodb-server-8.0.gpg ]]; then
            curl -fsSL --connect-timeout 20 --max-time 300 --retry 3 https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
            printf 'deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu %s/mongodb-org/8.0 multiverse\n' \
                "$codename" > /etc/apt/sources.list.d/mongodb-org-8.0.list
        fi
        if [[ ! -e /etc/apt/keyrings/githubcli-archive-keyring.gpg ]]; then
            curl -fsSL --connect-timeout 20 --max-time 300 --retry 3 https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
            printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
                "$arch" > /etc/apt/sources.list.d/github-cli.list
        fi
    fi
    # shellcheck disable=SC2086 # a word list
    local missing
    missing=$(dpkg-query -W -f='${Package} ${db:Status-Abbrev}\n' $HB_PACKAGES 2>/dev/null | awk '$2 != "ii" { print $1 }' || true)
    # dpkg-query prints nothing for a package it never heard of.
    # shellcheck disable=SC2086
    for p in $HB_PACKAGES; do dpkg-query -W "$p" >/dev/null 2>&1 || missing="$missing $p"; done
    if [[ -n ${missing// /} ]]; then
        say "installing:$(echo "$missing" | tr '\n' ' ')"
        apt-get "${apt_bounds[@]}" update -q >/dev/null
        # shellcheck disable=SC2086
        apt_install $missing
    else
        say "ok: packages"
    fi
    getent group docker >/dev/null && id "$HB_USER" >/dev/null 2>&1 && usermod -a -G docker "$HB_USER"
    if systemctl list-unit-files mongod.service >/dev/null 2>&1; then systemctl enable --now mongod.service >/dev/null 2>&1 || true; fi
    if systemctl list-unit-files syncthing@.service >/dev/null 2>&1 && id "$HB_USER" >/dev/null 2>&1; then
        systemctl enable "syncthing@$HB_USER.service" >/dev/null 2>&1 || true
    fi
}

phase_firewall() {
    nft -c -f "$hb_dir/firewall.nft" || die "firewall.nft does not parse"
    put 0644 "$hb_dir/firewall.nft" "$etc/hetzner-workbox/firewall.nft" || true
    put 0644 "$hb_dir/systemd/hetzner-workbox-firewall.service" "$etc/systemd/system/hetzner-workbox-firewall.service" || true
    systemctl daemon-reload
    systemctl enable hetzner-workbox-firewall.service >/dev/null 2>&1
    systemctl restart hetzner-workbox-firewall.service
    say "ok: firewall loaded"
}

phase_rootssh() {
    local f
    f=$(mktemp)
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > "$f"
    if put 0644 "$f" "$etc/ssh/sshd_config.d/10-hetzner-workbox.conf"; then
        sshd -t && systemctl reload ssh.service 2>/dev/null || systemctl restart ssh.socket 2>/dev/null || true
    else
        say "ok: root ssh is keys only"
    fi
    rm -f "$f"
}

ts_running() { tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null; }

phase_tailscale() {
    need tailscale jq
    systemctl enable --now tailscaled.service >/dev/null 2>&1
    if ts_running; then
        say "ok: Tailscale runs as $(tailscale status --json | jq -r .Self.HostName), $(tailscale ip -4 | head -n 1)"
        return
    fi
    [[ -n ${TS_AUTHKEY:-} ]] || die "Tailscale is not logged in: rerun with TS_AUTHKEY in the environment (a one-off key from the admin console)"
    # tailscale reads file:/dev/stdin; the key never reaches argv or a file.
    printf '%s' "$TS_AUTHKEY" | tailscale up --auth-key=file:/dev/stdin --hostname="$HB_TS_NAME" --accept-dns=true --ssh=false
    ts_running || die "tailscale up did not reach Running"
    say "Tailscale up as $HB_TS_NAME, $(tailscale ip -4 | head -n 1)"
}

phase_sshd() {
    local listen=$HB_SSH_LISTEN cfg
    if [[ -z $listen ]]; then
        ts_running || die "Tailscale is not running; run the tailscale phase first (or set HB_SSH_LISTEN)"
        listen=$(tailscale ip -4 | head -n 1)
    fi
    cfg=$(mktemp)
    sed -e "s/__TAILSCALE_IPV4__/$listen/" -e "s/^Port .*/Port $HB_SSH_PORT/" -e "s/^AllowUsers .*/AllowUsers $HB_USER/" \
        "$system_dir/bite-workbox-sshd_config" > "$cfg"
    local changed=0
    put 0600 "$cfg" "$etc/ssh/bite-workbox-sshd_config" && changed=1
    rm -f "$cfg"
    # sync.sh brings the exe box's host key at the cutover, so the Mac's
    # known_hosts entry for bite-workbox stays valid; until then a new one.
    if [[ ! -f $etc/ssh/bite-workbox-ssh-host-ed25519-key ]]; then
        ssh-keygen -q -t ed25519 -N '' -f "$etc/ssh/bite-workbox-ssh-host-ed25519-key"
        changed=1
    fi
    put 0644 "$system_dir/bite.slice" "$etc/systemd/system/bite.slice" && changed=1
    put 0644 "$system_dir/bite-workbox-sshd.service" "$etc/systemd/system/bite-workbox-sshd.service" && changed=1
    /usr/sbin/sshd -t -f "$etc/ssh/bite-workbox-sshd_config" || die "bite-workbox-sshd_config does not parse"
    systemctl daemon-reload
    systemctl enable bite.slice bite-workbox-sshd.service >/dev/null 2>&1
    systemctl start bite.slice
    if ((changed)) || ! systemctl is-active --quiet bite-workbox-sshd.service; then
        systemctl restart bite-workbox-sshd.service
    fi
    say "ok: sshd on $listen:$HB_SSH_PORT for $HB_USER"
}

phase_tools() {
    "$hb_dotfiles/workbox/system-tools.sh" btrfs shells qemu go pwsh tmp diskfree
}

# storage.sh and what it reads, copied out of the home (a root unit runs them at each boot, so not
# from a checkout the user writes), then applied now.
phase_storage() {
    local lib=${HB_LIB:-/usr/local/lib/hetzner-workbox} f changed=0
    for f in common.sh storage.sh storage.conf; do
        if put "$([[ $f == *.sh ]] && echo 0755 || echo 0644)" "$hb_dir/$f" "$lib/$f"; then changed=1; fi
    done
    if put 0644 "$hb_dir/systemd/hetzner-workbox-storage.service" "$etc/systemd/system/hetzner-workbox-storage.service"; then changed=1; fi
    if ((changed)); then systemctl daemon-reload; fi
    systemctl is-enabled --quiet hetzner-workbox-storage.service 2>/dev/null || systemctl enable --quiet hetzner-workbox-storage.service
    "$lib/storage.sh" apply
    # The durable run areas' boot rules: /runs/vperf2, and /tmp/vperf2 a link to it (made now too, so
    # the move finds it; a boot makes it again after emptying /tmp).
    local runs_conf
    runs_conf=$(mktemp)
    sed "s/__UID__/$HB_UID/g" "$hb_dir/systemd/tmpfiles.d/hetzner-runs.conf" > "$runs_conf"
    put 0644 "$runs_conf" "$etc/tmpfiles.d/hetzner-runs.conf" || true
    rm -f "$runs_conf"
    systemd-tmpfiles --create ${HB_TARGET:+"--root=$HB_TARGET"} - < "$etc/tmpfiles.d/hetzner-runs.conf"
}

phase_reserve() {
    "$hb_dotfiles/workbox/system-tools.sh" reserve slices
}

phase_upgrades() {
    dpkg-query -W unattended-upgrades >/dev/null 2>&1 || apt_install unattended-upgrades
    put 0644 "$system_dir/20auto-upgrades" "$etc/apt/apt.conf.d/20auto-upgrades" || say "ok: unattended upgrades"
    systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
}

phase_sysctl() {
    local conf=$etc/sysctl.d/90-inotify.conf
    put 0644 "$hb_dotfiles/workbox/systemd/sysctl.d/90-inotify.conf" "$conf" || say "ok: $conf"
    sysctl -q -p "$conf"
}

phase_backup() {
    if [[ -z ${HB_STORAGEBOX_HOST:-} || -z ${HB_STORAGEBOX_USER:-} ]]; then
        say "backup: skipped; rerun with HB_STORAGEBOX_HOST and HB_STORAGEBOX_USER set (README.md, Backups)"
        return
    fi
    "$hb_dir/backup.sh" install
}

phase_bootstrap() {
    local boot=$HB_HOME/Developer/personal/dotfiles/workbox/bootstrap.sh
    if [[ ! -x $boot ]]; then
        say "bootstrap: the home has no dotfiles yet. Next: sync.sh (RUNBOOK.md), then rerun: provision.sh bootstrap"
        return
    fi
    # bootstrap.sh needs the user's systemd (linger started it) and sudo.
    local uid
    uid=$(id -u "$HB_USER")
    runuser -u "$HB_USER" -- env HOME="$HB_HOME" USER="$HB_USER" XDG_RUNTIME_DIR="/run/user/$uid" \
        PATH="$HB_HOME/.local/bin:$HB_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" "$boot"
}

for p in "${phases[@]}"; do
    declare -F "phase_$p" >/dev/null || die "unknown phase: $p (one of: host user keys packages tools storage firewall rootssh tailscale sshd reserve upgrades sysctl backup bootstrap)"
done
for p in "${phases[@]}"; do
    say "phase $p"
    "phase_$p"
done
