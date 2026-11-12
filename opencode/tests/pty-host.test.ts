// The terminal host keeps one program on a live pty and answers other
// processes on a Unix socket: each test serves a real shell program and calls
// the host through the same client gamut uses.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { HostError, hostCall, rowsSince, serve, type HostScreen, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { scratch as scratchDir } from "./scratch.ts"

describe("rows since the last read", () => {
  test("an unchanged screen adds nothing", () => {
    expect(rowsSince(["a", "b"], ["a", "b"])).toEqual({ added: [], gone: 0 })
  })

  test("rows written below the last read are added", () => {
    expect(rowsSince(["a", "b"], ["a", "b", "c", "d"])).toEqual({ added: ["c", "d"], gone: 0 })
  })

  test("a row that moved as the scrollback grew is not new", () => {
    // The live row `> ` sits under the history; a new history row lands above it.
    expect(rowsSince(["one", "> "], ["one", "two", "> "])).toEqual({ added: ["two"], gone: 0 })
  })

  test("a row drawn over is added, and the row it replaced is gone", () => {
    expect(rowsSince(["a", "working 1s", "z"], ["a", "working 2s", "z"])).toEqual({
      added: ["working 2s"],
      gone: 1,
    })
  })

  test("the first read has every row", () => {
    expect(rowsSince([], ["a", "b"])).toEqual({ added: ["a", "b"], gone: 0 })
  })
})

const SIZE = { cols: 60, rows: 12 }
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Poll `check` every 20 ms until it returns a value, failing loudly after `ms`. */
const until = async <A>(what: string, check: () => Promise<A | undefined> | A | undefined, ms = 5000): Promise<A> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const scratch = () => {
  const dir = scratchDir("ocg-pty-host-").path
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Serve `script` under `sh`; the host stops on `down` or after the test. */
const hosted = async (script: string, onFrame?: (rows: ReadonlyArray<string>) => void) => {
  const dir = scratch()
  const socket = join(dir, "host.sock")
  const host: ServedHost = serve({ socket, cwd: dir, command: ["/bin/sh", "-c", script], env: ENV, ...SIZE }, onFrame)
  cleanups.push(() => host.stop())
  await until("the host to listen", () => (existsSync(socket) ? true : undefined))
  return { socket, host, dir }
}

const screenShows = (socket: string, text: string) =>
  until(`the screen to show ${text}`, async () => {
    const screen = await hostCall(socket, { op: "read", scope: "screen" })
    return screen.rows.some((row) => row.includes(text)) ? screen : undefined
  })

const typeLine = async (socket: string, text: string) => {
  await hostCall(socket, { op: "type", text })
  await hostCall(socket, { op: "keys", names: ["enter"] })
}

const failure = async (promise: Promise<unknown>): Promise<HostError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof HostError) return error
    throw error
  }
  throw new Error("the call succeeded")
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The ids a program script wrote to `<dir>/pids`, one per start. */
const startedPids = (dir: string) =>
  existsSync(join(dir, "pids"))
    ? readFileSync(join(dir, "pids"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map(Number)
    : []

const RECORDS_ITS_PID = `echo $$ >> pids; exec sleep 60`

const processArgs = () => Bun.spawnSync(["ps", "-axo", "args="]).stdout.toString()

describe("terminal host", () => {
  test("the frame observer sees text erased before the first screen read", async () => {
    const frames: string[] = []
    const { socket } = await hosted(`printf 'transient toast'; read line; printf '\\033[2J\\033[Hcleared'; while read line; do :; done`, (rows) => frames.push(rows.join("\n")))
    await until("the transient frame", () => frames.some((frame) => frame.includes("transient toast")) || undefined)
    await typeLine(socket, "clear")
    const screen = await screenShows(socket, "cleared")
    expect(screen.rows.join("\n")).not.toContain("transient toast")
    expect(frames.some((frame) => frame.includes("transient toast"))).toBe(true)
  })

  test("typed text and keys reach the program, and a read has only the rows added since the last", async () => {
    const { socket } = await hosted(`printf 'hello\\n'; while read line; do echo "got $line"; done`)
    await screenShows(socket, "hello")
    expect((await hostCall(socket, { op: "read", scope: "changes" })).rows).toEqual(["hello"])
    await typeLine(socket, "abc")
    await screenShows(socket, "got abc")
    // The pty echoes the typed line, then the program answers it.
    expect((await hostCall(socket, { op: "read", scope: "changes" })).rows).toEqual(["abc", "got abc"])
    expect((await hostCall(socket, { op: "read", scope: "changes" })).rows).toEqual([])
  })

  test("a long screen of wide characters arrives whole", async () => {
    // Several replies' worth of multi-byte rows: a reply cut at a socket
    // buffer, or decoded chunk by chunk, would break the JSON or a glyph.
    const { socket } = await hosted(`i=0; while [ $i -lt 400 ]; do echo "◆ row $i ✓ ▸ ┃ ─────"; i=$((i+1)); done; exec sleep 60`)
    const screen = await until("all rows", async () => {
      const read: HostScreen = await hostCall(socket, { op: "read", scope: "changes" })
      return read.rows.some((row) => row.includes("row 399")) ? read : undefined
    })
    expect(screen.rows.every((row) => row.startsWith("◆ row ") && row.endsWith("✓ ▸ ┃ ─────"))).toBe(true)
  })

  test("an unknown key is refused by name, and nothing is written", async () => {
    const { socket } = await hosted(`while read line; do echo "got $line"; done`)
    const refused = await failure(hostCall(socket, { op: "keys", names: ["enter", "nope"] }))
    expect(refused.tag).toBe("UnknownKey")
    expect(refused.message).toContain("no key named nope")
    // Had the refused call written its enter, the program would answer an empty line first.
    await typeLine(socket, "abc")
    await screenShows(socket, "got abc")
    expect((await hostCall(socket, { op: "read", scope: "changes" })).rows).toEqual(["abc", "got abc"])
  })

  test("a program that exits leaves its last screen and its code, and takes no more input", async () => {
    const { socket } = await hosted(`echo bye; exit 3`)
    await screenShows(socket, "bye")
    const screen = await until("the exit code", async () => {
      const read = await hostCall(socket, { op: "read", scope: "full" })
      return read.exited === undefined ? undefined : read
    })
    expect(screen.exited).toBe(3)
    expect((await failure(hostCall(socket, { op: "type", text: "x" }))).tag).toBe("ProgramExited")
  })

  test("restart quits the program with ctrl+c and starts the new one on a fresh mark", async () => {
    const { socket } = await hosted(`printf 'first\\n'; exec sleep 60`)
    await screenShows(socket, "first")
    await hostCall(socket, { op: "read", scope: "changes" })
    await hostCall(socket, { op: "restart", command: ["/bin/sh", "-c", "printf 'second\\n'; exec sleep 60"] })
    await screenShows(socket, "second")
    const rows = (await hostCall(socket, { op: "read", scope: "changes" })).rows
    expect(rows).toContain("second")
    expect(rows).not.toContain("first")
  })

  test("two restarts at once leave one program running", async () => {
    const { socket, dir } = await hosted(RECORDS_ITS_PID)
    await until("the first program", () => (startedPids(dir).length === 1 ? true : undefined))
    // Each restart's program carries `marker` as its shell's `$0`, so the
    // process table counts them: a program the other restart quit may never
    // have run a line.
    const marker = join(dir, "restarted")
    const again = ["/bin/sh", "-c", "sleep 60; :", marker] as const
    await Promise.all([
      hostCall(socket, { op: "restart", command: again }),
      hostCall(socket, { op: "restart", command: again }),
    ])
    // A restart returns once its program has started and the one before it
    // has exited, so the count is final here.
    expect(processArgs().split("\n").filter((line) => line.includes(marker))).toHaveLength(1)
    expect(startedPids(dir).map(alive)).toEqual([false])
  })

  test("a stopped host closes its program", async () => {
    const { host, dir } = await hosted(RECORDS_ITS_PID)
    const [pid] = await until("the program", () => (startedPids(dir).length === 1 ? startedPids(dir) : undefined))
    await host.stop()
    await until("the program to exit", () => (alive(pid!) ? undefined : true))
  })

  test("a host whose socket will not bind fails and closes its program", async () => {
    const dir = scratch()
    // The bind fails before the program could write its id, so the program is
    // found by its directory, which its shell carries as `$0`.
    const host = serve({
      socket: join(dir, "missing/host.sock"),
      cwd: dir,
      command: ["/bin/sh", "-c", "sleep 60; :", dir],
      env: ENV,
      ...SIZE,
    })
    expect(await host.stopped.then(() => "stopped", () => "failed")).toBe("failed")
    await until("the program to exit", () => (processArgs().includes(dir) ? undefined : true))
  })

  test("down quits the program and stops the host", async () => {
    const { socket, host } = await hosted(`printf 'up\\n'; exec sleep 60`)
    await screenShows(socket, "up")
    expect(await hostCall(socket, { op: "down" })).toEqual({ killed: false })
    await host.stopped
    expect((await failure(hostCall(socket, { op: "read", scope: "screen" }))).tag).toBe("HostGone")
  })

  test(
    "down kills a program that ignores ctrl+c once the quit deadline passes",
    async () => {
      const { socket, host } = await hosted(`trap '' INT; printf 'stubborn\\n'; while :; do sleep 1; done`)
      await screenShows(socket, "stubborn")
      expect(await hostCall(socket, { op: "down" })).toEqual({ killed: true })
      await host.stopped
    },
    30_000,
  )
})
