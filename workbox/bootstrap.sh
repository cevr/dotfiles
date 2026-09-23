#!/bin/sh

set -eu
umask 077

workbox_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
system_dir="$workbox_dir/systemd/system"
resolved_config="$workbox_dir/systemd/resolved.conf.d/workbox.conf"
user_unit_dir="$HOME/.config/systemd/user"
local_bin_dir="$HOME/.local/bin"

if [ "$(uname -s)" = Linux ] && [ -S "/run/user/$(id -u)/bus" ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
fi

check_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'workbox bootstrap: required command is missing: %s\n' "$1" >&2
    exit 1
  }
}

check_memory_protection() {
  service_name=$1
  memory_min=$2
  memory_low=$3
  oom_score_adjust=$4

  test "$(systemctl show "$service_name" -p Slice --value)" = bite.slice
  test "$(systemctl show "$service_name" -p MemoryMin --value)" -eq "$memory_min"
  test "$(systemctl show "$service_name" -p MemoryLow --value)" -eq "$memory_low"
  test "$(systemctl show "$service_name" -p MemorySwapMax --value)" -eq 0
  test "$(systemctl show "$service_name" -p OOMScoreAdjust --value)" -eq "$oom_score_adjust"
}

check_mode() {
  for command in bite-rift btrfs bun curl git herdr hunk jq mongosh node redis-cli rift sideshow sqlite3 syncthing tailscale workbox-release-valve workbox-rift-storage zsh; do
    check_command "$command"
  done

  herdr config check
  HERDR_SESSION=bite herdr plugin action list --plugin cvr.herdr-hunk |
    grep -q '"action_id":"send"'
  test -L "$HOME/.zshenv"
  test -L "$HOME/.zshrc"
  systemctl --user is-active --quiet sideshow.service
  systemctl --user is-active --quiet herdr-bite.service
  systemctl --user is-active --quiet workbox-backup.timer
  systemctl --user is-active --quiet workbox-health.timer
  systemctl --user is-active --quiet workbox-update-report.timer
  systemctl is-active --quiet bite-workbox-sshd.service
  systemctl is-active --quiet bite-workbox-sideshow-firewall.service
  systemctl is-active --quiet bite-agent-settings.path
  systemctl is-enabled --quiet bite.slice
  systemctl is-active --quiet bite.slice
  test "$(systemctl show bite.slice -p MemoryMin --value)" -eq 268435456
  test "$(systemctl show bite.slice -p MemoryLow --value)" -eq 536870912
  test "$(systemctl show bite.slice -p MemorySwapMax --value)" -eq 0
  check_memory_protection tailscaled.service 134217728 268435456 -900
  check_memory_protection systemd-resolved.service 33554432 67108864 -800
  check_memory_protection bite-workbox-sshd.service 33554432 67108864 -900
  systemctl is-enabled --quiet bite-workbox-resolver.service
  systemctl is-active --quiet bite-workbox-resolver.service
  systemctl is-enabled --quiet systemd-resolved.service
  systemctl is-active --quiet systemd-resolved.service
  test "$(readlink /etc/resolv.conf)" = ../run/systemd/resolve/stub-resolv.conf
  cmp -s "$resolved_config" /etc/systemd/resolved.conf.d/workbox.conf
  "$local_bin_dir/workbox-rift-storage" --check
  "$local_bin_dir/bite-rift" check
  "$local_bin_dir/install-node" --check
  swapon --show --noheadings | grep -q .

  printf 'Workbox bootstrap checks passed.\n'
}

if [ "${1:-}" = "--check" ]; then
  check_mode
  exit 0
fi

if [ "$#" -ne 0 ]; then
  printf 'usage: %s [--check]\n' "$0" >&2
  exit 2
fi

if [ "$(uname -s)" != Linux ]; then
  printf 'workbox bootstrap: this command requires Linux\n' >&2
  exit 1
fi

for command in curl git jq syncthing tailscale; do
  check_command "$command"
done

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  btrfs-progs \
  nftables \
  sqlite3 \
  systemd-resolved \
  unattended-upgrades \
  zsh

mkdir -p "$local_bin_dir" "$user_unit_dir" "$HOME/.agents"
mkdir -p "$HOME/.config/bite-workbox/patches" "$HOME/.config/herdr" "$HOME/.config/hunk"

ln -sfn "$workbox_dir/zshenv" "$HOME/.zshenv"
ln -sfn "$workbox_dir/zshrc" "$HOME/.zshrc"
ln -sfn "$workbox_dir/../AGENTS.md" "$HOME/.agents/AGENTS.md"
ln -sfn "$workbox_dir/../skills" "$HOME/.agents/skills"
sudo chsh -s /usr/bin/zsh "$USER"

for script in "$workbox_dir"/bin/*; do
  install -m 755 "$script" "$local_bin_dir/$(basename "$script")"
done
install -m 644 "$workbox_dir/bun-tools.txt" "$HOME/.config/bite-workbox/bun-tools.txt"
install -m 644 "$workbox_dir/herdr-plugins.txt" "$HOME/.config/bite-workbox/herdr-plugins.txt"
install -m 644 "$workbox_dir/herdr-config.toml" "$HOME/.config/herdr/config.toml"
install -m 644 "$workbox_dir/hunk-config.toml" "$HOME/.config/hunk/config.toml"
install -m 600 "$workbox_dir/backup.env" "$HOME/.config/bite-workbox/backup.env"

"$local_bin_dir/install-bun-tools"
"$local_bin_dir/install-herdr-plugins"
"$local_bin_dir/workbox-rift-storage" --apply
"$local_bin_dir/install-node"

for unit in "$workbox_dir"/systemd/user/*; do
  install -m 644 "$unit" "$user_unit_dir/$(basename "$unit")"
done

sudo install -m 0644 "$system_dir/bite-agent-settings.service" /etc/systemd/system/
sudo install -m 0644 "$system_dir/bite-agent-settings.path" /etc/systemd/system/
sudo install -m 0644 "$system_dir/bite-workbox-sideshow-firewall.service" /etc/systemd/system/
sudo install -m 0644 "$system_dir/bite-workbox-sshd.service" /etc/systemd/system/
sudo install -m 0644 "$system_dir/bite-workbox-resolver.service" /etc/systemd/system/
sudo install -m 0644 "$system_dir/bite.slice" /etc/systemd/system/
sudo install -m 0644 "$system_dir/bite-workbox-sideshow.nft" /etc/nftables.d/bite-workbox-sideshow.nft
sudo install -m 0644 "$system_dir/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
sudo install -d -m 0755 /etc/systemd/system/tailscaled.service.d
sudo install -m 0644 \
  "$system_dir/tailscaled.service.d/20-bite-memory-protection.conf" \
  /etc/systemd/system/tailscaled.service.d/20-bite-memory-protection.conf
sudo install -d -m 0755 /etc/systemd/system/systemd-resolved.service.d
sudo install -m 0644 \
  "$system_dir/systemd-resolved.service.d/20-bite-memory-protection.conf" \
  /etc/systemd/system/systemd-resolved.service.d/20-bite-memory-protection.conf
sudo install -d -m 0755 /etc/systemd/resolved.conf.d
sudo install -m 0644 "$resolved_config" /etc/systemd/resolved.conf.d/workbox.conf

tailscale_ipv4=$(tailscale ip -4 | head -1)
sshd_config_file=$(mktemp)
trap 'rm -f "$sshd_config_file"' EXIT HUP INT TERM
sed "s/__TAILSCALE_IPV4__/$tailscale_ipv4/" \
  "$system_dir/bite-workbox-sshd_config" > "$sshd_config_file"
sudo install -m 0600 "$sshd_config_file" /etc/ssh/bite-workbox-sshd_config

if [ ! -f /etc/ssh/bite-workbox-ssh-host-ed25519-key ]; then
  sudo ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/bite-workbox-ssh-host-ed25519-key
fi

if [ ! -f /swapfile ]; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
fi

if ! swapon --show --noheadings | awk '{print $1}' | grep -qx /swapfile; then
  sudo swapon /swapfile
fi

if ! grep -q '^/swapfile none swap sw 0 0$' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' | sudo tee -a /etc/fstab >/dev/null
fi

sudo systemctl daemon-reload
systemctl --user daemon-reload
sudo loginctl enable-linger "$USER"
sudo systemctl enable --now bite.slice
sudo systemctl unmask systemd-resolved.service
sudo systemctl enable --now systemd-resolved.service
sudo ln -sfn ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
sudo systemctl restart systemd-resolved.service
sudo systemctl restart tailscaled.service
tailscale_attempt=0
until tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null; do
  tailscale_attempt=$((tailscale_attempt + 1))
  if [ "$tailscale_attempt" -ge 30 ]; then
    printf 'workbox bootstrap: Tailscale did not return to the running state\n' >&2
    exit 1
  fi
  sleep 1
done
sudo tailscale set --accept-dns=true
sudo systemctl unmask apt-daily.timer apt-daily-upgrade.timer
sudo systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
sudo systemctl enable --now \
  bite-agent-settings.path \
  bite-workbox-resolver.service \
  bite-workbox-sideshow-firewall.service \
  bite-workbox-sshd.service
sudo systemctl restart bite-workbox-sshd.service
systemctl --user enable --now \
  cleanup-mosh-servers.timer \
  sideshow.service \
  workbox-backup.timer \
  workbox-health.timer \
  workbox-update-report.timer
"$local_bin_dir/migrate-herdr-to-systemd"
systemctl --user restart sideshow.service

if [ -d "$HOME/.config/bite-workbox/settings-source" ]; then
  "$local_bin_dir/apply-agent-settings"
fi

if ! claude plugin marketplace list 2>/dev/null | grep -q sideshow; then
  claude plugin marketplace add --scope user modem-dev/sideshow
fi

if ! claude plugin list 2>/dev/null | grep -q 'sideshow@sideshow'; then
  claude plugin install --scope user \
    --config sideshowUrl=http://localhost:8228 \
    sideshow@sideshow
fi

"$local_bin_dir/backup-state"
check_mode
