// The leak check accept.ts runs after a run, and the spawn helper the tests use
// so there is nothing for it to find. Real process trees of `sh` and `sleep`.
import { describe, expect, test } from "bun:test"
import { owned } from "../tests/owned.ts"
import { descendants, isServer, parseTable, type Proc, servers, stop, survivors, table, watch } from "./leaks.ts"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

import { observed } from "../tests/owned.ts"
import { hangGuard, watchdog } from "../tests/hang-guard.ts"

const EVENT_WAIT_MS = 30_000

const until = async (done: () => boolean) => {
  const deadline = watchdog(EVENT_WAIT_MS)
  while (!done() && !deadline.expired()) await Bun.sleep(50)
  return done()
}

describe("the leak check", () => {
  test("reads ps rows and walks a tree", () => {
    const rows = parseTable(
      [
        "  10     1    10 Sat Nov  7 19:17:52 2026 bun test --parallel",
        "  11    10    10 Sat Nov  7 19:17:53 2026 bunx opencode-drive run scenarios/mail.ts",
        "  12    11    10 Sat Nov  7 19:17:54 2026 /bun /fork/packages/cli/src/index.ts serve --service --port 0",
        "  13     1    13 Sat Nov  7 19:00:00 2026 /home/u/.local/share/opencode-prime/opencode-2.2.5-prime.5fd8679b serve",
      ].join("\n"),
    )
    expect(rows[2]).toEqual({ pid: 12, ppid: 11, pgid: 10, started: "Sat Nov 7 19:17:54 2026", args: "/bun /fork/packages/cli/src/index.ts serve --service --port 0" })
    expect(descendants(rows, 10).map((row) => row.pid)).toEqual([11, 12])
    expect(rows.map(isServer)).toEqual([false, true, true, true])
    // Only what the run started is ever a candidate: the owner's server is not its descendant.
    expect(servers(descendants(rows, 10)).map((row) => row.pid)).toEqual([11, 12])
  })

  test("a server a run started and left behind, handed to pid 1, is found and stopped; one that ended is not", async () => {
    // Keep both children, then the parent, alive until the watch has actually seen them.
    const run = Bun.spawn(["sh", "-c", 'sh -c "sleep 120; : opencode-drive run" & sh -c "sleep 120; : opencode-drive run short" & read release'], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    const watching = watch(run.pid, 100)
    const seeing = () => watching.sample().filter(isServer)
    expect(await until(() => seeing().length === 2 && watching.sample().filter((proc) => proc.args === "sleep 120").length === 2), "the two process trees to be sampled").toBe(true)
    const short = seeing().find((proc) => proc.args.endsWith(" short"))
    if (short) {
      await stop([short, ...descendants(table(), short.pid)])
      expect(await until(() => !alive(short.pid)), "the short-lived server to be stopped").toBe(true)
    }
    run.stdin.write("go\n")
    run.stdin.end()
    await run.exited
    const seen = watching.stop()
    const left = survivors(seen, table())
    expect(left.map((proc) => proc.args).toSorted()).toEqual(["sh -c sleep 120; : opencode-drive run", "sleep 120"])
    const strays = servers(left)
    expect(strays.map((proc) => proc.args)).toEqual(["sh -c sleep 120; : opencode-drive run"])
    expect(strays[0]?.ppid).toBe(run.pid)
    await stop([...left])
    expect(left.every((proc: Proc) => !alive(proc.pid))).toBe(true)
  }, hangGuard("process-tree"))
})

describe("owned", () => {
  test("stops what the child started when the child exits", async () => {
    const child = owned(["sh", "-c", "sleep 120 & echo $!; read release"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    const grandchild = Number(new TextDecoder().decode((await child.stdout.getReader().read()).value).trim())
    expect(alive(grandchild)).toBe(true)
    child.stdin.write("go\n")
    child.stdin.end()
    expect(await until(() => Number.isInteger(child.exitCode) && !alive(grandchild)), "the child to exit and its grandchild to be gone").toBe(true)
  }, hangGuard("process-tree"))

  test("stops what the child started in a process group of its own, as opencode-drive starts its server", async () => {
    const child = owned(["sh", "-c", 'perl -e "setpgrp(0, 0); sleep 120" & echo $!; read release'], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    const grandchild = Number(new TextDecoder().decode((await child.stdout.getReader().read()).value).trim())
    expect(await until(() => observed(child.pid)?.some((proc) => proc.pid === grandchild && proc.pgid === grandchild) === true), "the grandchild to be sampled in its own group").toBe(true)
    child.stdin.write("go\n")
    child.stdin.end()
    expect(await until(() => Number.isInteger(child.exitCode) && !alive(grandchild)), "the child to exit and separately grouped grandchild to be gone").toBe(true)
  }, hangGuard("process-tree"))

  test("a child killed alone takes its group with it", async () => {
    const child = owned(["sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe", stderr: "ignore" })
    const reader = child.stdout.getReader()
    const grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim())
    child.kill()
    expect(await until(() => child.signalCode === "SIGTERM" && !alive(grandchild)), "the child to die by SIGTERM and take its group with it").toBe(true)
  }, hangGuard("process-tree"))
})
