// A shell command in a few words, and whether it only waits.
import { describe, expect, test } from "bun:test"
import { brief, label, shellAction, waits, waitsInput } from "./shell.ts"

// The owner's five lanes on the workbox, as their shell calls read.
const LANES = {
  closureFlake: "D=/home/exedev/.cache/baton/wf10/closure-flake; for i in $(seq 1 19); do [ -s $D/gate-r2.log ] && break; sleep 30; done; tail -5 $D/gate-r2.log",
  pkgLower: 'for i in $(seq 1 19); do grep -q "merge exit\\|gate exit [1-9]" /home/exedev/.cache/baton/wf10/pkg-lower/r2gate.log && break; sleep 30; done',
  gateTestDisk: "D=/home/exedev/.cache/baton/wf10/gate-test-disk; while [ ! -f $D/gates.done ] && kill -0 3399700 2>/dev/null; do sleep 20; done",
  authority: "cd /home/exedev/Developer/personal/.worktrees/effra-authority && flock /home/exedev/.cache/baton/wf10/gate.lock ./scripts/gate.sh > /tmp/gate.log 2>&1",
  stdText: "cd /home/exedev/Developer/personal/.worktrees/effra-std-text && uptime; systemd-run --user --wait --pipe --collect -p MemoryMax=8G bun run gate",
}

describe("a command in a few words", () => {
  test("its main command and what it acts on, past its setup, wrappers and redirections, paths by their last part", () => {
    expect(brief(LANES.authority)).toBe("flock gate.lock ./scripts/gate.sh")
    expect(brief(LANES.stdText)).toBe("bun run gate")
    expect(brief("env CI=1 timeout 600 bun test src/money.test.ts")).toBe("bun test src/money.test.ts")
    expect(brief('bash -c "bun test src/money.test.ts"')).toBe("bun test src/money.test.ts")
  })

  test("a poll loop by the file it watches", () => {
    expect(brief(LANES.closureFlake)).toBe("polling gate-r2.log")
    expect(brief(LANES.pkgLower)).toBe("polling r2gate.log")
    expect(brief(LANES.gateTestDisk)).toBe("polling gates.done")
    expect(brief("while true; do sleep 5; done")).toBe("polling")
  })

  test("more commands after the main one read as an ellipsis; nothing reads as nothing", () => {
    expect(brief("git status --short && git diff")).toBe("git status …")
    expect(brief("bun test money")).toBe("bun test money")
    expect(brief("  ")).toBe("")
  })

  test("a call's own description wins, on one line", () => {
    expect(label({ command: LANES.authority, description: "Run the gate\nunder the shared lock" })).toBe("Run the gate under the shared lock")
    expect(label({ command: LANES.authority })).toBe("flock gate.lock ./scripts/gate.sh")
    expect(label({ command: LANES.authority, description: " " })).toBe("flock gate.lock ./scripts/gate.sh")
  })
})

describe("the wait rule", () => {
  test("a loop that sleeps waits; so does a command that only sleeps or waits", () => {
    expect([LANES.closureFlake, LANES.pkgLower, LANES.gateTestDisk].map(waits)).toEqual([true, true, true])
    expect(waits("sleep 600")).toBe(true)
    expect(waits("cd /x && sleep 30")).toBe(true)
    expect(waits("wait")).toBe(true)
  })

  test("work, and a lock that queues before work, do not", () => {
    expect(waits(LANES.authority)).toBe(false)
    expect(waits(LANES.stdText)).toBe(false)
    expect(waits("bun test money")).toBe(false)
    expect(waits("for f in a b; do bun test $f; done")).toBe(false)
    expect(waits("sleep 2 && bun test")).toBe(false)
  })

  test("a description that opens with a waiting verb waits, whatever the command", () => {
    expect(waitsInput({ command: LANES.authority, description: "Wait for the gate lock" })).toBe(true)
    expect(waitsInput({ command: "gh run watch 123", description: "Poll CI" })).toBe(true)
    expect(waitsInput({ command: LANES.authority, description: "Run the gate (it waits for the lock)" })).toBe(false)
    expect(waitsInput({ command: "sleep 60", description: "Give the server a minute" })).toBe(true)
  })
})

describe("a shell call's action", () => {
  test("is its action field, run for a command without one, and an older transcript's flag form reads the same", () => {
    expect(shellAction({ command: "ls" })).toBe("run")
    expect(shellAction({ action: "run", command: "ls" })).toBe("run")
    expect(shellAction({ action: "check", id: "sh_1" })).toBe("check")
    expect(shellAction({ action: "wait", id: "sh_1", ms: 500 })).toBe("wait")
    expect(shellAction({ action: "kill", id: "sh_1" })).toBe("kill")
    expect(shellAction({ action: "list" })).toBe("list")
    // The flag forms before actions.
    expect(shellAction({ id: "sh_1" })).toBe("check")
    expect(shellAction({ id: "sh_1", wait: 500 })).toBe("wait")
    expect(shellAction({ id: "sh_1", kill: true })).toBe("kill")
    expect(shellAction({ list: true })).toBe("list")
    // A wait on a shell only waits.
    expect(waitsInput({ action: "wait", id: "sh_1" })).toBe(true)
    expect(waitsInput({ action: "kill", id: "sh_1" })).toBe(false)
  })
})
