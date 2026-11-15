#!/bin/sh
# A stand-in for headless Chrome, for the browser adapter's test: it appends
# its arguments to $FAKE_BROWSER_LOG and, unless $FAKE_BROWSER_MODE is
# "blank", writes a 2 × 3 PNG header to the --screenshot path it was given.
# In mode "hang" it starts a helper (as Chrome does), logs "pids <its own>
# <the helper's>", and waits for the helper, a minute.
printf '%s\n' "$*" >> "$FAKE_BROWSER_LOG"
[ "$FAKE_BROWSER_MODE" = blank ] && { echo "headless: page crashed" >&2; exit 4; }
if [ "$FAKE_BROWSER_MODE" = hang ]; then
  sleep 60 &
  printf 'pids %s %s\n' "$$" "$!" >> "$FAKE_BROWSER_LOG"
  wait
fi
for arg in "$@"; do
  case "$arg" in
    --screenshot=*) printf '\211PNG\r\n\032\n\000\000\000\rIHDR\000\000\000\002\000\000\000\003' > "${arg#--screenshot=}" ;;
  esac
done
exit 0
