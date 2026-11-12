// `owned(command, options)`: `Bun.spawn` for a test's child that may start
// others (opencode-drive and its server and TUIs, an OpenCode server, a
// `run --standalone` and its `serve --stdio`). Everything the child starts is
// stopped (SIGTERM, then SIGKILL) when the child exits, and, for a child still
// running, when the test process exits: a test that failed, timed out or never
// reached its own `kill`.
//
// A process group is not enough: opencode-drive starts its server and each
// TUI in a group of its own and leaves them running when it is stopped. So the
// child's descendants are sampled while it runs (scripts/leaks.ts `watch`),
// which still names them once they are handed to pid 1. scripts/accept.ts
// checks that no server survives a run.
//
// Each child gets a TMPDIR of its own (tests/scratch.ts `childTemp`), removed
// once it and all it started have stopped: opencode-drive makes
// `$TMPDIR/opencode-drive` and the driven OpenCode `$TMPDIR/opencode`, and
// neither removes its folder. A TMPDIR the test chose for the child is kept.
import { descendants, type Proc, stop, survivors, table, watch, type Watch } from "../scripts/leaks.ts"
import { type ChildTemp, childTemp } from "./scratch.ts"

/** How often a running child's descendants are sampled. */
const SAMPLE_MS = 1000

/** How long what a child started has between SIGTERM and SIGKILL. */
const GRACE_MS = 3000

/** The children of this process still running, each with its descendants' watch. */
const running = new Map<number, Watch>()

/** Each child's own TMPDIR, removed once the child and all it started have stopped. */
const temps = new Map<number, ChildTemp>()

/** The children `owned` started, each to the end of its cleanup. */
const releases = new Map<number, Promise<void>>()

const terminate = (procs: ReadonlyArray<Proc>) => {
  for (const proc of procs)
    try {
      process.kill(proc.pid, "SIGTERM")
    } catch {
      // Gone in between.
    }
}

/** Signal the process group `group` leads; false once it is empty. */
const signalGroup = (group: number, name: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-group, name)
    return true
  } catch {
    return false
  }
}

// A test process that ends, by any path, takes what its children started with it.
process.on("exit", () => {
  const rows = table()
  for (const [pid, watching] of running) {
    signalGroup(pid, "SIGTERM")
    terminate(survivors([...watching.stop(), ...descendants(rows, pid)], rows))
  }
  for (const temp of temps.values()) temp[Symbol.dispose]()
})

/**
 * `Bun.spawn` whose child leads a process group of its own, and whose
 * descendants, in that group or not, are stopped when it exits or the test
 * process does.
 */
export const owned = <
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(
  command: ReadonlyArray<string>,
  options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> => {
  const temp = childTemp(options?.env)
  const child = Bun.spawn([...command], { ...options, env: temp.env, detached: true })
  const watching = watch(child.pid, SAMPLE_MS)
  running.set(child.pid, watching)
  temps.set(child.pid, temp)
  const release = child.exited.then(async () => {
    running.delete(child.pid)
    const left = survivors(watching.stop(), table())
    if (signalGroup(child.pid, "SIGTERM")) {
      const deadline = Date.now() + GRACE_MS
      while (signalGroup(child.pid, 0) && Date.now() < deadline) await Bun.sleep(50)
      signalGroup(child.pid, "SIGKILL")
    }
    await stop(left, GRACE_MS)
    temp[Symbol.dispose]()
    temps.delete(child.pid)
    releases.delete(child.pid)
  })
  releases.set(child.pid, release)
  return child
}

/** To await: settles once the owned child `pid`, all it started and its own TMPDIR are gone (nothing to wait for once they are). */
export const released = (pid: number) => releases.get(pid)
