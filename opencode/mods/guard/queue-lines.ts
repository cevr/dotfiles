// The real shell lines of the host-admit-queue incident (workbox and Mac,
// 2026-11-26), verbatim from the process table and the run ledger: the
// guard's classification of each is asserted in heavy-lines.test.ts.
export const QUEUE_LINES = {
  /** Lease :277 on the workbox: an Ergo agent's wait loop, guard-wrapped at
   * unknown width (whole pool) for 2 h 46 min. Its pgrep pattern matches the
   * loop's own command line, so it never ends. */
  selfMatchingWait: "while pgrep -f 'sh /tmp/opencode/csc/both.sh' >/dev/null; do sleep 15; done; L=/home/exedev/.cache/baton/wf10/units/CHECK-SELFHOST-CUTOVER; grep -E '^exit|missing, .* extra|^--- |^[-+]site|red' $L/iter-5.log | cut -c1-260; diff <(grep -E '^\\s+[A-Z][A-Za-z]+( [a-z]+)? +[0-9]+ of +[0-9]+|typed [0-9]+ of' $L/expr-main.log) <(grep -E '^\\s+[A-Z][A-Za-z]+( [a-z]+)? +[0-9]+ of +[0-9]+|typed [0-9]+ of' $L/expr-r2b.log) | cut -c1-200",
  /** Lease :1542: a declared width 4 over a script, recorded width unknown. */
  declaredScript: "host-admit check run --class check --width 4 -- timeout 30m sh /home/exedev/.cache/baton/wf10/light.sh sh /tmp/opencode/orch4/ex.sh",
  /** Bite case 5: declared width 2 over `timeout 600 sh script`. */
  declaredTimeout: "host-admit check run --class check --width 2 -- timeout 600 sh /tmp/vperf2/leg.sh",
  /** A declared check inside cd, a redirect and an echo: the guard wrapped it again. */
  declaredInside: "cd /home/exedev/Developer/personal/ergo && host-admit check run --class check --width 4 -- timeout 45m bun test --parallel=4 src > /tmp/law.log 2>&1; echo exit $?",
  /** Case 6, the self-deadlock: the guard wrapped this whole line, and the
   * explicit host-admit inside waited behind its own wrapper. */
  declaredAfterAssignment: "R=/tmp/vperf2/r88; host-admit check run --class check --width 2 -- timeout 900 sh $R/leg.sh $R/out > $R/log 2>&1; echo $?",
  /** Case 8: a plain sed edit queued 11 min. */
  plainSedEdit: "cd /home/exedev/Developer/personal/ergo && f=/tmp/opencode/orch4/units.json && sed -i 's|\"state\": \"open\"|\"state\": \"done\"|; s|\"round\": 1|\"round\": 2|' $f && grep -o '\"state\": \"[a-z]*\"' $f",
  /** Plain read lines that must never queue. */
  plainGit: "git -C /home/exedev/Developer/work/bite log --oneline -5 && git status --short",
  plainSed: "sed -n '1,80p' /tmp/opencode/notes.md | grep -n admission",
  plainCat: "cat /proc/loadavg; echo ok",
  plainProbe: "ps -u $(id -u) -o pid=,args= | grep -E 'host-admit' | grep -v grep",
  /** Still heavy: a real test run, and one under a wrapper. */
  heavyTest: "bun test --parallel=4 mods/guard",
  heavyCd: "cd opencode && bun run typecheck > /tmp/tc.log 2>&1",
} as const
