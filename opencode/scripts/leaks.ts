// What a test run leaves running. `watch(pid)` samples the process table while
// the run lives and keeps every process descended from `pid`, so it still knows
// a test's OpenCode server once its parent died and it was handed to pid 1.
// When the run ends, `survivors` are those still alive (the same process: its
// start time and arguments unchanged), and `servers` the ones that are an
// OpenCode server or an opencode-drive run: the leaks accept.ts refuses.
//
// Only descendants of the watched run are ever named, so the owner's own
// servers (`opencode-…-prime.… serve`) and TUIs are never among them.

/** One row of the process table. */
export interface Proc {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  /** When it started, as `ps` prints it: with the pid, what makes it the same process. */
  readonly started: string
  readonly args: string
}

/** The process table now (`ps`), on macOS and Linux. */
export const table = (): ReadonlyArray<Proc> => {
  const ran = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,args="], { stdout: "pipe", stderr: "ignore" })
  return parseTable(ran.stdout.toString())
}

/** `ps -axo pid=,ppid=,pgid=,lstart=,args=` rows; `lstart` is five words (`Sat Nov  7 19:17:52 2026`). */
export const parseTable = (text: string): ReadonlyArray<Proc> =>
  text.split("\n").flatMap((line) => {
    const words = line.trim().split(/\s+/)
    if (words.length < 9) return []
    const [pid, ppid, pgid] = words.slice(0, 3).map(Number)
    if (pid === undefined || ppid === undefined || pgid === undefined || [pid, ppid, pgid].some(Number.isNaN)) return []
    return [{ pid, ppid, pgid, started: words.slice(3, 8).join(" "), args: words.slice(8).join(" ") }]
  })

/** The processes of `rows` descended from `root` (not `root` itself). */
export const descendants = (rows: ReadonlyArray<Proc>, root: number): ReadonlyArray<Proc> => {
  const children = new Map<number, Array<Proc>>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const found = new Map<number, Proc>()
  const queue = [root]
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const child of children.get(next) ?? []) {
      if (child.pid === root || found.has(child.pid)) continue
      found.set(child.pid, child)
      queue.push(child.pid)
    }
  return [...found.values()]
}

/** Of the processes `seen`, those `rows` still holds: the same pid, start time and arguments. */
export const survivors = (seen: ReadonlyArray<Proc>, rows: ReadonlyArray<Proc>): ReadonlyArray<Proc> => {
  const now = new Map(rows.map((row) => [row.pid, row]))
  return seen.filter((proc) => {
    const row = now.get(proc.pid)
    return row !== undefined && row.started === proc.started && row.args === proc.args
  })
}

/** An OpenCode server (the fork from source or a binary, `serve`) or an opencode-drive run. */
export const isServer = (proc: Proc): boolean => /opencode-drive|(opencode[^\s]*|packages\/cli\/src\/index\.ts)\s(.*\s)?serve(\s|$)/.test(proc.args)

/** The servers among `procs`. */
export const servers = (procs: ReadonlyArray<Proc>): ReadonlyArray<Proc> => procs.filter(isServer)

export interface Watch {
  /** Sample now, then stop sampling; every descendant the samples saw. */
  readonly stop: () => ReadonlyArray<Proc>
}

/** Sample the descendants of `root` every `everyMs` until `stop`. */
export const watch = (root: number, everyMs = 1000, read: () => ReadonlyArray<Proc> = table): Watch => {
  const seen = new Map<string, Proc>()
  const sample = () => {
    for (const proc of descendants(read(), root)) seen.set(`${proc.pid} ${proc.started}`, proc)
  }
  sample()
  const timer = setInterval(sample, everyMs)
  return {
    stop: () => {
      clearInterval(timer)
      sample()
      return [...seen.values()]
    },
  }
}

/** Stop `procs` (each still the process `survivors` found): SIGTERM, then SIGKILL after `graceMs` for any left. */
export const stop = async (procs: ReadonlyArray<Proc>, graceMs = 3000, read: () => ReadonlyArray<Proc> = table): Promise<void> => {
  const signal = (targets: ReadonlyArray<Proc>, name: NodeJS.Signals) => {
    for (const proc of survivors(targets, read()))
      try {
        process.kill(proc.pid, name)
      } catch {
        // Gone in between.
      }
  }
  signal(procs, "SIGTERM")
  const deadline = Date.now() + graceMs
  while (survivors(procs, read()).length > 0 && Date.now() < deadline) await Bun.sleep(100)
  signal(procs, "SIGKILL")
}

/** One line per process, for a report. */
export const listing = (procs: ReadonlyArray<Proc>): string => procs.map((proc) => `  ${proc.pid} (ppid ${proc.ppid}) ${proc.args.slice(0, 200)}`).join("\n")
