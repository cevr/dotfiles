#!/bin/sh
# A stand-in for Rex's tool, for the adapter's test: it appends its
# arguments to $FAKE_REX_LOG, one line each, and answers from $FAKE_REX_MODE.
#   ok        block ls lists a shell, a showcase and an unlabeled block; split makes block:new; close succeeds
#   fail      every call exits 3 with "no such session" on stderr
#   garbage   every call prints what is not JSON
#   gone      close exits 1, and block ls lists only the shell
printf '%s\n' "$*" >> "$FAKE_REX_LOG"
case "$FAKE_REX_MODE" in
  fail) echo "no such session" >&2; exit 3 ;;
  garbage) echo "not json"; exit 0 ;;
esac
case "$1 $2" in
  "block ls")
    if [ "$FAKE_REX_MODE" = gone ]; then
      echo '{"blocks":[{"block_id":"block:1","label":"shell"}]}'
    else
      echo '{"blocks":[{"block_id":"block:1","label":"shell"},{"block_id":"block:2","label":"showcase"},{"block_id":"block:3"}]}'
    fi ;;
  "block close")
    [ "$FAKE_REX_MODE" = gone ] && exit 1
    exit 0 ;;
  split*) echo '{"anchor_id":"block:1","block_ids":["block:new"],"split_ids":["split:1"],"revision":4}' ;;
  *) echo "unknown: $1 $2" >&2; exit 9 ;;
esac
