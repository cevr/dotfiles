#!/usr/bin/env bash
# Run as the disposable guest's sudo-capable fixture user, with its pin
# supplied independently by the VM driver. Only the scratch fixture is made.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
cd "$here/../.."
pin=${RESTORE_MACHINE_ID:?supply the recovery host pin from the fixture record}
[[ $pin =~ ^[0-9a-f]{32}$ ]] || exit 2
sudo -n true
scratch=$(mktemp -d /var/tmp/hetzner-restore-doc.XXXXXXXX)
[[ $scratch =~ ^/var/tmp/hetzner-restore-doc\.[a-zA-Z0-9]{8}$ ]] || exit 2
trap 'rm -r -- "$scratch"' EXIT
export BACKUP_COPY="$scratch/backup copy" BACKUP_HOST_LABEL=lost-workbox
mkdir -p "$BACKUP_COPY/$BACKUP_HOST_LABEL/2026-12"
info="$BACKUP_COPY/$BACKUP_HOST_LABEL/2026-12/runs.sample.info"
touch "$info"

# Extract the first fenced shell example under Restore. Replace only the
# documented placeholder, just as the operator would, not the command.
awk '
    /^### Restore$/ { restore = 1; next }
    restore && /^```sh$/ { block = 1; next }
    block && /^```$/ { exit }
    block { print }
' "$here/README.md" > "$scratch/list.sh"
test -s "$scratch/list.sh"
printf '%s\n' '--- Documented restore preflight template ---'
cat "$scratch/list.sh"
placeholder='<machine-id-from-deployment-record>'
[[ $(grep -oF -- "$placeholder" "$scratch/list.sh" | wc -l) -eq 1 ]]
sed "s/$placeholder/$pin/" "$scratch/list.sh" > "$scratch/with-pin.sh"
sed "s/$placeholder//" "$scratch/list.sh" > "$scratch/no-pin.sh"

code=0
listing=$(env -u WORKBOX_EXPECT_MACHINE_ID bash "$scratch/with-pin.sh" 2>&1) || code=$?
printf 'documented restore list with recorded pin: exit %s; %s\n' "$code" "$listing"
[[ $code == 0 && $listing == *"$info" ]]

code=0
listing=$(env -u WORKBOX_EXPECT_MACHINE_ID bash "$scratch/no-pin.sh" 2>&1) || code=$?
printf 'documented restore list without recorded pin: exit %s; %s\n' "$code" "$listing"
[[ $code == 78 && $listing == *'intended-host identity refused'* && $listing != *"$info"* ]]
