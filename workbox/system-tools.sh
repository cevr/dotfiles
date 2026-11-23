#!/bin/sh
# The system layer both workboxes share (pinned tools, the CPU, IO and memory reserve, the run
# families' slices, /tmp's rules, the free-space figures), as root. bootstrap.sh runs it
# (sudo) on the exe.dev workbox and provision.sh's `tools` and `reserve` phases on the Hetzner box, so
# both paths install the same things from one place; the pins are in pins.conf beside it.
#
# Usage: sudo system-tools.sh [step...]   (default: every step, in this order)
#        system-tools.sh --check [step...]  (no root; fails, naming the step, unless installed)
# Steps:
#   btrfs   btrfs-progs with simple quotas (BTRFS_PROGS_MIN): the distribution's when it is new enough,
#           else the pinned package, its sha256 checked before it is installed. Refused on another arch.
#   shells  fish, ksh and mksh from the distribution (SHELL_PACKAGES)
#   qemu    qemu-user-static (qemu-user-binfmt from Ubuntu 26.04), and its binfmt_misc entry for the other architecture (aarch64 on
#           amd64, x86_64 on arm64) registered now with the F flag, from the package's binfmt.d file
#           (systemd-binfmt registers the package's others at boot)
#   go      Go GO_VERSION for GO_ARCH from go.dev: the tarball's sha256 checked before it is
#           unpacked, into /usr/local/go-<version>; /usr/local/go is a link to it, swapped by one
#           rename; /usr/local/bin/go and gofmt link to /usr/local/go/bin. Refused on another arch.
#   pwsh    PowerShell from Microsoft's apt repository; the key is refused unless its fingerprint is
#           MICROSOFT_KEY_FINGERPRINT. Refused on an arch other than PWSH_ARCH.
#   reserve the systemd drop-ins that give the OpenCode service a memory floor (systemd/reserve/),
#           then `systemctl daemon-reload`, which applies them to running units without a restart.
#           bite.slice's CPU and IO weights are in bite.slice itself (bootstrap and provision install it).
#   slices  the run families' slices of the user manager from slices.conf (/etc/systemd/user/<name>.slice),
#           the system slices' weights from it (drop-ins), and cpu, io and memory delegated to each user
#           manager (systemd/slices/), then `systemctl daemon-reload`. A user manager takes the delegation
#           when it next starts (a boot); its slices with its own daemon-reload.
#   tmp     /tmp's rules (systemd/tmp/tmpfiles.d/tmp.conf as /etc/tmpfiles.d/tmp.conf: emptied at boot,
#           aged daily) and the daily clean through workbox-tmp-clean, which keeps what a process holds
#   diskfree  workbox-disk-free and its timer: the btrfs free-space figures in /run/workbox/disk-free
#
# Idempotent: a step that finds its state prints `ok: ...`; one that changes something prints
# `==> installed ...`. A refusal changes nothing and exits 1.
#
# For the tests only: WORKBOX_TOOLS_ROOT is a prefix for every path written or read (a scratch root),
# WORKBOX_TOOLS_PROC stands for /proc, and WORKBOX_PINS names another pins file.
set -eu

here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
pins=${WORKBOX_PINS:-$here/pins.conf}
# shellcheck source-path=SCRIPTDIR source=pins.conf
. "$pins"
root=${WORKBOX_TOOLS_ROOT:-}
proc=${WORKBOX_TOOLS_PROC:-/proc}
reserve_dir=$here/systemd/reserve
slices_dir=$here/systemd/slices
slices_conf=${WORKBOX_SLICES:-$here/slices.conf}
all_steps="btrfs shells qemu go pwsh reserve slices tmp diskfree"

say() { printf '==> %s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
die() { printf 'system-tools: %s\n' "$*" >&2; exit 1; }

# Every scratch path the script makes is under $scratch, or listed in $scratch_paths (the Go unpack,
# which must be on /usr/local's file system); the one EXIT trap removes them on every exit path.
scratch=$(mktemp -d)
scratch_paths=$scratch
# shellcheck disable=SC2086 # a word list of paths without spaces
trap 'rm -rf $scratch_paths' EXIT
trap 'exit 130' INT TERM HUP

# Network calls are bounded: a stalled download fails after its time, not never.
curl_bounds="--connect-timeout 20 --max-time 900 --retry 3 --retry-delay 5"
apt_bounds="-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3"

# Debian's name for this machine's architecture (amd64, arm64), as the Go and apt pins name it.
host_arch() {
  if command -v dpkg >/dev/null 2>&1; then
    dpkg --print-architecture
    return
  fi
  case $(uname -m) in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) uname -m ;;
  esac
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

fetch() { # url file
  # shellcheck disable=SC2086 # a word list
  curl -fsSL $curl_bounds -o "$2" "$1" || die "could not download $1"
}

# Replaces (or makes) the link $2 so it points at $1, by one rename(2): a reader sees the old target
# or the new one, never no link. perl is in perl-base, which Debian and Ubuntu always install.
swap_link() { # target link
  if [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; then return 1; fi
  ln -s "$1" "$2.new.$$"
  perl -e 'rename($ARGV[0], $ARGV[1]) or die "rename $ARGV[0] -> $ARGV[1]: $!\n"' "$2.new.$$" "$2"
}

# Installs a file only when it differs (mode src dest); succeeds only when it changed something.
put() {
  if [ -e "$3" ] && cmp -s "$2" "$3"; then return 1; fi
  install -d -m 0755 "$(dirname "$3")"
  install -m "$1" "$2" "$3"
  say "installed $3"
}

installed() { [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null)" = "ii " ]; }

# Installs the packages not yet installed (apt-get update first); prints which.
apt_ensure() {
  missing=
  for package in "$@"; do
    installed "$package" || missing="$missing $package"
  done
  if [ -z "$missing" ]; then
    ok "packages $*"
    return
  fi
  say "installing$missing"
  # shellcheck disable=SC2086 # word lists
  apt-get $apt_bounds update -q >/dev/null
  # NEEDRESTART_SUSPEND: Ubuntu's needrestart hook would restart services after the install.
  # shellcheck disable=SC2086 # word lists
  NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive apt-get $apt_bounds install -y -q $missing >/dev/null
  for package in $missing; do
    installed "$package" || die "apt-get did not install $package"
  done
}

# ---------------------------------------------------------------- btrfs
# The installed btrfs-progs version ("6.6.3"), or nothing.
btrfs_version() { btrfs --version 2>/dev/null | awk '{ sub(/^v/, "", $2); print $2; exit }'; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }
btrfs_new_enough() {
  have=$(btrfs_version)
  [ -n "$have" ] && version_ge "$have" "$BTRFS_PROGS_MIN"
}

step_btrfs() {
  if btrfs_new_enough; then
    ok "btrfs-progs $have (simple quotas)"
    return
  fi
  arch=$(host_arch)
  [ "$arch" = "$BTRFS_PROGS_ARCH" ] ||
    die "btrfs: btrfs-progs ${have:-(none)} is older than $BTRFS_PROGS_MIN and the pinned package is for $BTRFS_PROGS_ARCH only; this host is $arch: refusing"
  deb=$scratch/${BTRFS_PROGS_DEB_URL##*/}
  fetch "$BTRFS_PROGS_DEB_URL" "$deb"
  got=$(sha256_of "$deb")
  [ "$got" = "$BTRFS_PROGS_SHA256" ] ||
    die "btrfs: ${deb##*/} has sha256 $got, not the pinned $BTRFS_PROGS_SHA256: refusing it; nothing was installed"
  # apt reads a local package as its _apt user: the scratch directory is root's 0700 otherwise.
  chmod 0755 "$scratch"
  say "installing ${deb##*/} (btrfs-progs ${have:-none} is older than $BTRFS_PROGS_MIN)"
  # shellcheck disable=SC2086 # a word list
  NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive apt-get $apt_bounds install -y -q "$deb" >/dev/null
  btrfs_new_enough || die "btrfs: btrfs-progs is ${have:-missing} after installing ${deb##*/}"
  say "installed btrfs-progs $have"
}

check_btrfs() {
  btrfs_new_enough || die "check btrfs: btrfs-progs ${have:-(none)} is older than $BTRFS_PROGS_MIN (no simple quotas)"
}

# ---------------------------------------------------------------- shells
step_shells() {
  # shellcheck disable=SC2086 # a word list
  apt_ensure $SHELL_PACKAGES
}

check_shells() {
  for shell in $SHELL_PACKAGES; do
    command -v "$shell" >/dev/null 2>&1 || die "check shells: $shell is not on PATH"
  done
}

# ---------------------------------------------------------------- qemu
# The binfmt_misc entry this host needs: the other of the two architectures the workbox runs.
foreign() {
  case $(host_arch) in
    amd64) echo aarch64 ;;
    arm64) echo x86_64 ;;
    *) die "qemu: no binfmt entry is chosen for a $(host_arch) host (amd64 or arm64)" ;;
  esac
}

binfmt_ok() { # entry file
  [ -f "$1" ] && [ "$(head -n 1 "$1")" = enabled ] && grep -q '^flags: .*F' "$1"
}

qemu_installed() {
  for package in $QEMU_PACKAGES; do
    if installed "$package"; then return 0; fi
  done
  return 1
}

step_qemu() {
  if qemu_installed; then
    ok "packages $QEMU_PACKAGES (one of)"
  else
    # shellcheck disable=SC2086 # a word list
    apt-get $apt_bounds update -q >/dev/null
    choice=
    for package in $QEMU_PACKAGES; do
      candidate=$(apt-cache policy "$package" | awk '/Candidate:/ { print $2 }')
      if [ -n "$candidate" ] && [ "$candidate" != "(none)" ]; then
        choice=$package
        break
      fi
    done
    [ -n "$choice" ] || die "qemu: none of $QEMU_PACKAGES has an installation candidate"
    apt_ensure "$choice"
  fi
  arch=$(foreign)
  entry=$proc/sys/fs/binfmt_misc/qemu-$arch
  if binfmt_ok "$entry"; then
    ok "binfmt qemu-$arch"
    return
  fi
  conf=$root/usr/lib/binfmt.d/qemu-$arch.conf
  [ -f "$conf" ] || die "qemu: $conf is missing (the qemu package ships it)"
  [ -e "$proc/sys/fs/binfmt_misc/register" ] || die "qemu: binfmt_misc is not mounted at $proc/sys/fs/binfmt_misc"
  line=$(grep -v '^[[:space:]]*#' "$conf" | grep . | head -n 1)
  case $line in
    *:*F*) ;;
    *) die "qemu: $conf registers without the F flag: $line" ;;
  esac
  # An entry without F (binfmt-support's) or disabled goes first: the kernel refuses a second name.
  if [ -e "$entry" ]; then printf -- '-1' > "$entry"; fi
  # systemd-binfmt with a file registers that file's entry now, as it does every binfmt.d file at boot.
  PATH="$PATH:/usr/lib/systemd:/lib/systemd" systemd-binfmt "$conf"
  binfmt_ok "$entry" || die "qemu: qemu-$arch did not register enabled with the F flag"
  say "installed binfmt qemu-$arch"
}

check_qemu() {
  qemu_installed || die "check qemu: none of $QEMU_PACKAGES is installed"
  binfmt_ok "$proc/sys/fs/binfmt_misc/qemu-$(foreign)" || die "check qemu: binfmt qemu-$(foreign) is not enabled with the F flag"
}

# ---------------------------------------------------------------- go
go_local=$root/usr/local
go_tree=$go_local/go-$GO_VERSION
go_tarball=go$GO_VERSION.linux-$GO_ARCH.tar.gz

go_arch_ok() {
  arch=$(host_arch)
  [ "$arch" = "$GO_ARCH" ] ||
    die "go: Go $GO_VERSION is pinned for linux-$GO_ARCH only (its sha256 in pins.conf); this host is $arch: refusing to install another architecture's tarball"
}

# The pinned tree is in place: the link names it, and it holds the version and the sha it came from.
go_current() {
  [ "$(readlink "$go_local/go" 2>/dev/null)" = "go-$GO_VERSION" ] &&
    [ "$(head -n 1 "$go_tree/VERSION" 2>/dev/null)" = "go$GO_VERSION" ] &&
    [ "$(cat "$go_tree/.workbox-sha256" 2>/dev/null)" = "$GO_SHA256" ]
}

go_links() {
  install -d -m 0755 "$go_local/bin"
  for name in go gofmt; do
    if swap_link "../go/bin/$name" "$go_local/bin/$name"; then say "installed $go_local/bin/$name"; fi
  done
}

step_go() {
  go_arch_ok
  if go_current; then
    ok "Go $GO_VERSION at $go_local/go"
    go_links
    return
  fi
  install -d -m 0755 "$go_local"
  work=$(mktemp -d "$go_local/.go-install.XXXXXX")
  scratch_paths="$scratch_paths $work"
  fetch "https://go.dev/dl/$go_tarball" "$work/$go_tarball"
  got=$(sha256_of "$work/$go_tarball")
  [ "$got" = "$GO_SHA256" ] ||
    die "go: $go_tarball has sha256 $got, not the pinned $GO_SHA256: refusing it; nothing was installed"
  mkdir "$work/unpacked"
  tar -xzf "$work/$go_tarball" -C "$work/unpacked"
  [ "$(head -n 1 "$work/unpacked/go/VERSION" 2>/dev/null)" = "go$GO_VERSION" ] ||
    die "go: $go_tarball does not hold go$GO_VERSION; nothing was installed"
  printf '%s\n' "$GO_SHA256" > "$work/unpacked/go/.workbox-sha256"
  # A tree of this version that did not pass go_current (a partial copy) goes aside first.
  if [ -e "$go_tree" ]; then mv "$go_tree" "$work/stale-tree"; fi
  mv "$work/unpacked/go" "$go_tree"
  # A real directory at /usr/local/go (Go installed by hand) is the one moment without a Go: two
  # renames apart. After that /usr/local/go is a link, and the next version swaps it in one rename.
  if [ -d "$go_local/go" ] && [ ! -L "$go_local/go" ]; then mv "$go_local/go" "$work/hand-installed"; fi
  swap_link "go-$GO_VERSION" "$go_local/go" || true
  for tree in "$go_local"/go-[0-9]*; do
    [ "$tree" = "$go_tree" ] || [ ! -d "$tree" ] || rm -rf "$tree"
  done
  rm -rf "$work"
  say "installed Go $GO_VERSION at $go_local/go (-> go-$GO_VERSION)"
  go_links
}

check_go() {
  go_arch_ok
  go_current || die "check go: $go_local/go is not the verified Go $GO_VERSION"
  for name in go gofmt; do
    [ "$(readlink "$go_local/bin/$name" 2>/dev/null)" = "../go/bin/$name" ] || die "check go: $go_local/bin/$name does not link to ../go/bin/$name"
  done
}

# ---------------------------------------------------------------- pwsh
ms_keyring=$root/usr/share/keyrings/microsoft-prod.gpg
ms_list=$root/etc/apt/sources.list.d/microsoft-prod.list

# The fingerprints of a key file's primary keys, one per line (gpg reads armored and binary alike).
primary_fingerprints() {
  gpg_home=$(mktemp -d "$scratch/gpg.XXXXXX")
  GNUPGHOME=$gpg_home gpg --batch --quiet --no-autostart --show-keys --with-colons "$1" 2>/dev/null |
    awk -F: '$1 == "pub" { want = 1; next } $1 == "sub" { want = 0 } $1 == "fpr" && want { print $10; want = 0 }'
  rm -rf "$gpg_home"
}

only_pinned_key() { [ "$(primary_fingerprints "$1")" = "$MICROSOFT_KEY_FINGERPRINT" ]; }

ms_line() {
  # shellcheck disable=SC1091 # the host's file
  [ -f "$root/etc/os-release" ] || die "pwsh: $root/etc/os-release is missing"
  # shellcheck disable=SC1091
  release=$(. "$root/etc/os-release" && printf '%s %s %s' "$ID" "$VERSION_ID" "$VERSION_CODENAME")
  # shellcheck disable=SC2086 # three words
  set -- $release
  [ "$1" = ubuntu ] || die "pwsh: Microsoft's repository is chosen for Ubuntu; this host is $1"
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/%s/prod %s main\n' "$PWSH_ARCH" "$2" "$3"
}

step_pwsh() {
  arch=$(host_arch)
  [ "$arch" = "$PWSH_ARCH" ] ||
    die "pwsh: Microsoft's repository has the powershell package for $PWSH_ARCH only; this host is $arch: refusing"
  if [ -f "$ms_keyring" ] && only_pinned_key "$ms_keyring"; then
    ok "Microsoft key $MICROSOFT_KEY_FINGERPRINT"
  else
    scratch_key=$(mktemp -d "$scratch/key.XXXXXX")
    fetch "$MICROSOFT_KEY_URL" "$scratch_key/key.asc"
    found=$(primary_fingerprints "$scratch_key/key.asc" | tr '\n' ' ')
    only_pinned_key "$scratch_key/key.asc" ||
      die "pwsh: the key at $MICROSOFT_KEY_URL has fingerprint ${found:-none}, not the pinned $MICROSOFT_KEY_FINGERPRINT: refusing it; nothing was installed"
    GNUPGHOME=$scratch_key gpg --batch --quiet --no-autostart --yes --dearmor -o "$scratch_key/key.gpg" "$scratch_key/key.asc"
    put 0644 "$scratch_key/key.gpg" "$ms_keyring"
    rm -rf "$scratch_key"
  fi
  line=$(ms_line)
  # apt refuses the same repository under two signed-by keys: name another list that has it.
  for other in "$root"/etc/apt/sources.list.d/*; do
    [ "$other" != "$ms_list" ] && [ -f "$other" ] || continue
    if grep -q 'packages\.microsoft\.com/ubuntu' "$other"; then
      die "pwsh: $other names packages.microsoft.com too; remove it (this step writes $ms_list)"
    fi
  done
  list=$(mktemp "$scratch/list.XXXXXX")
  printf '%s\n' "$line" > "$list"
  put 0644 "$list" "$ms_list" || ok "$ms_list"
  rm -f "$list"
  apt_ensure powershell
}

check_pwsh() {
  if [ ! -f "$ms_keyring" ] || ! only_pinned_key "$ms_keyring"; then die "check pwsh: $ms_keyring is not the pinned Microsoft key"; fi
  command -v pwsh >/dev/null 2>&1 || die "check pwsh: pwsh is not on PATH"
}

# ---------------------------------------------------------------- reserve
# Each file under systemd/reserve/<manager>/<dir>/ goes to /etc/systemd/<manager>/<dir>/.
reserve_files() { (cd "$reserve_dir" && find . -type f -name '*.conf' | sed 's|^\./||' | sort); }

step_reserve() {
  changed=0
  for file in $(reserve_files); do
    if put 0644 "$reserve_dir/$file" "$root/etc/systemd/$file"; then changed=1; fi
  done
  if [ "$changed" = 1 ]; then
    systemctl daemon-reload
  else
    ok "reserve drop-ins"
  fi
}

check_reserve() {
  for file in $(reserve_files); do
    cmp -s "$reserve_dir/$file" "$root/etc/systemd/$file" || die "check reserve: $root/etc/systemd/$file is not $reserve_dir/$file"
  done
}

# ---------------------------------------------------------------- slices
# slices.conf's lines, comments and blank lines dropped: "<unit> <manager> <Setting=value>...".
slice_lines() { sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$slices_conf" | grep . > "$scratch/slices"; }

# What slices.conf makes for one line, written to $1: a whole slice unit for the user manager (the
# run families), a drop-in for the system manager's own slices.
slice_text() { # file line
  out=$1
  # shellcheck disable=SC2086 # the line's words
  set -- $2
  unit=$1 manager=$2
  shift 2
  {
    printf '# Made by workbox/system-tools.sh from workbox/slices.conf: change it there.\n'
    if [ "$manager" = user ]; then
      printf '[Unit]\nDescription=Workbox run family %s (workbox/slices.conf)\n\n' "${unit%.slice}"
    fi
    printf '[Slice]\n'
    printf '%s\n' "$@"
  } > "$out"
}

slice_dest() { # unit manager
  case $2 in
    user) echo "$root/etc/systemd/user/$1" ;;
    system) echo "$root/etc/systemd/system/$1.d/40-workbox-slices.conf" ;;
  esac
}

slices_files() { (cd "$slices_dir" && find . -type f -name '*.conf' | sed 's|^\./||' | sort); }

step_slices() {
  changed=0
  for file in $(slices_files); do
    if put 0644 "$slices_dir/$file" "$root/etc/systemd/$file"; then changed=1; fi
  done
  made=$(mktemp "$scratch/slice.XXXXXX")
  slice_lines
  while IFS= read -r line; do
    # shellcheck disable=SC2086 # the line's first two words
    set -- $line
    case $1 in *.slice) ;; *) die "slices: $1 is not a slice name" ;; esac
    case $2 in user | system) ;; *) die "slices: $slices_conf names manager $2 for $1 (user or system)" ;; esac
    slice_text "$made" "$line"
    if put 0644 "$made" "$(slice_dest "$1" "$2")"; then changed=1; fi
  done < "$scratch/slices"
  if [ "$changed" = 1 ]; then
    systemctl daemon-reload
  else
    ok "slices from $slices_conf"
  fi
}

check_slices() {
  for file in $(slices_files); do
    cmp -s "$slices_dir/$file" "$root/etc/systemd/$file" || die "check slices: $root/etc/systemd/$file is not $slices_dir/$file"
  done
  made=$(mktemp "$scratch/slice.XXXXXX")
  slice_lines
  while IFS= read -r line; do
    # shellcheck disable=SC2086 # the line's first two words
    set -- $line
    slice_text "$made" "$line"
    cmp -s "$made" "$(slice_dest "$1" "$2")" || die "check slices: $(slice_dest "$1" "$2") is not what slices.conf makes"
  done < "$scratch/slices"
}

# ---------------------------------------------------------------- tmp
tmp_dir=$here/systemd/tmp
tmp_files() { # src dest mode, one per line
  printf '%s %s %s\n' \
    "$tmp_dir/tmpfiles.d/tmp.conf" "$root/etc/tmpfiles.d/tmp.conf" 0644 \
    "$tmp_dir/system/systemd-tmpfiles-clean.service.d/30-workbox-held.conf" "$root/etc/systemd/system/systemd-tmpfiles-clean.service.d/30-workbox-held.conf" 0644 \
    "$tmp_dir/workbox-tmp-clean" "$root/usr/local/sbin/workbox-tmp-clean" 0755
}

step_tmp() {
  changed=0
  tmp_files > "$scratch/tmp-files"
  while read -r src dest mode; do
    if put "$mode" "$src" "$dest"; then changed=1; fi
  done < "$scratch/tmp-files"
  if [ "$changed" = 1 ]; then
    systemctl daemon-reload
  else
    ok "tmp rules and the held-file guard"
  fi
}

check_tmp() {
  tmp_files > "$scratch/tmp-files"
  while read -r src dest mode; do
    cmp -s "$src" "$dest" || die "check tmp: $dest is not $src"
  done < "$scratch/tmp-files"
}

# ---------------------------------------------------------------- diskfree
disk_dir=$here/systemd/disk-free
disk_files() {
  printf '%s %s %s\n' \
    "$disk_dir/workbox-disk-free" "$root/usr/local/sbin/workbox-disk-free" 0755 \
    "$disk_dir/workbox-disk-free.service" "$root/etc/systemd/system/workbox-disk-free.service" 0644 \
    "$disk_dir/workbox-disk-free.timer" "$root/etc/systemd/system/workbox-disk-free.timer" 0644
}

step_diskfree() {
  changed=0
  disk_files > "$scratch/disk-files"
  while read -r src dest mode; do
    if put "$mode" "$src" "$dest"; then changed=1; fi
  done < "$scratch/disk-files"
  if [ "$changed" = 1 ]; then
    systemctl daemon-reload
    # A new timer starts; no running service is restarted.
    systemctl enable --now workbox-disk-free.timer
  elif ! systemctl is-enabled --quiet workbox-disk-free.timer 2>/dev/null; then
    systemctl enable --now workbox-disk-free.timer
    say "enabled workbox-disk-free.timer"
  else
    ok "workbox-disk-free.timer"
  fi
}

check_diskfree() {
  disk_files > "$scratch/disk-files"
  while read -r src dest mode; do
    cmp -s "$src" "$dest" || die "check diskfree: $dest is not $src"
  done < "$scratch/disk-files"
}

# ---------------------------------------------------------------- main
mode=apply
if [ "${1:-}" = --check ]; then
  mode=check
  shift
fi
# shellcheck disable=SC2086 # a word list
[ "$#" -gt 0 ] || set -- $all_steps
for step in "$@"; do
  case " $all_steps " in
    *" $step "*) ;;
    *) die "unknown step: $step (one of: $all_steps)" ;;
  esac
done
if [ "$mode" = apply ] && [ -z "$root" ] && [ "$(id -u)" != 0 ]; then
  die "run as root (sudo $0 $*)"
fi
for step in "$@"; do
  if [ "$mode" = check ]; then "check_$step"; else "step_$step"; fi
done
if [ "$mode" = check ]; then ok "system tools: $*"; fi
