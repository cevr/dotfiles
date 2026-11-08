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

const until = async (done: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await Bun.sleep(50)
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
    // The run: a shell that starts a long child named like a drive run and a short one, and exits after a second.
    const run = Bun.spawn(["sh", "-c", 'sh -c "sleep 30; : opencode-drive run" & sh -c "sleep 0.2; : opencode-drive run" & sleep 1'], { stdout: "ignore", stderr: "ignore" })
    const watching = watch(run.pid, 100)
    await run.exited
    const seen = watching.stop()
    const left = survivors(seen, table())
    expect(left.map((proc) => proc.args).toSorted()).toEqual(["sh -c sleep 30; : opencode-drive run", "sleep 30"])
    const strays = servers(left)
    expect(strays.map((proc) => proc.args)).toEqual(["sh -c sleep 30; : opencode-drive run"])
    expect(strays[0]?.ppid).toBe(run.pid)
    await stop([...left])
    expect(left.every((proc: Proc) => !alive(proc.pid))).toBe(true)
  })
})

describe("owned", () => {
  test("stops what the child started when the child exits", async () => {
    const child = owned(["sh", "-c", "sleep 30 & echo $!; sleep 0.3"], { stdout: "pipe", stderr: "ignore" })
    const grandchild = Number(new TextDecoder().decode((await child.stdout.getReader().read()).value).trim())
    expect(alive(grandchild)).toBe(true)
    await child.exited
    expect(await until(() => !alive(grandchild))).toBe(true)
  })

  test("stops what the child started in a process group of its own, as opencode-drive starts its server", async () => {
    const child = owned(["sh", "-c", 'perl -e "setpgrp(0, 0); sleep 30" & echo $!; sleep 1.5'], { stdout: "pipe", stderr: "ignore" })
    const grandchild = Number(new TextDecoder().decode((await child.stdout.getReader().read()).value).trim())
    await Bun.sleep(200)
    expect(table().find((proc) => proc.pid === grandchild)?.pgid).toBe(grandchild)
    await child.exited
    expect(await until(() => !alive(grandchild))).toBe(true)
  })

  test("a child killed alone takes its group with it", async () => {
    const child = owned(["sh", "-c", "sleep 30 & echo $!; wait"], { stdout: "pipe", stderr: "ignore" })
    const reader = child.stdout.getReader()
    const grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim())
    child.kill()
    await child.exited
    expect(await until(() => !alive(grandchild))).toBe(true)
  })
})
