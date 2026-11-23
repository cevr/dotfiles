# shellcheck shell=sh
# Sourced by workbox mutation entry points. Validation does not write or call sudo.
workbox_host_identity() {
  if [ -r /etc/machine-id ]; then
    IFS= read -r workbox_machine_id < /etc/machine-id || return 1
    printf '%s\n' "$workbox_machine_id"
  elif [ -x /usr/sbin/ioreg ]; then
    # The Mac-only fake-root tests use its own independent platform identity.
    /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice |
      awk -F '"' '/"IOPlatformUUID"/ { gsub(/-/, "", $4); print tolower($4); exit }'
  else
    return 1
  fi
}

workbox_require_host() {
  workbox_expected=${WORKBOX_EXPECT_MACHINE_ID:-}
  workbox_actual=$(workbox_host_identity) || workbox_actual=
  case "$workbox_expected" in
    ''|*[!0-9a-f]*|00000000000000000000000000000000) workbox_expected= ;;
  esac
  if [ "${#workbox_expected}" != 32 ] || [ "$workbox_expected" != "$workbox_actual" ]; then
    printf '%s\n' "${0##*/}: intended-host identity refused: supply the independently recorded WORKBOX_EXPECT_MACHINE_ID for this machine" >&2
    exit 78
  fi
}
