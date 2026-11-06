// Processes over `ps`: every process (`-A`, on macOS and Linux alike), its
// name (`comm`) and its full command line (`args`, never cut: `-ww`), read
// in two passes joined by PID, since either column may hold spaces. A `ps`
// that fails or prints nothing is ProcessesUnreadable, so the guard refuses
// a kill by pattern rather than guess.
import { Effect, Layer } from "effect"
import type { ProcessInfo } from "../kill.ts"
import { Processes, ProcessesUnreadable } from "../service.ts"

/** Each `<pid> <rest>` line of `ps -o pid=,<column>=`, by PID. */
export const parseColumn = (text: string): ReadonlyMap<number, string> =>
  new Map(
    text.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s(.*)$/.exec(line)
      return match === null ? [] : [[Number(match[1]), (match[2] ?? "").trim()] as const]
    }),
  )

const column = (ps: string, name: "comm" | "args") =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([ps, "-A", "-ww", "-o", `pid=,${name}=`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const code = await child.exited
      if (code !== 0) throw new Error(`ps exited ${code}: ${err.trim()}`)
      return out
    },
    catch: (cause) => new ProcessesUnreadable({ message: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(Effect.map(parseColumn))

/** The processes `ps` (by default the one on PATH) lists. */
export const layer = (ps = "ps") =>
  Layer.succeed(
    Processes,
    Processes.of({
      list: Effect.fn("Processes.list")(function* () {
        const [names, args] = yield* Effect.all([column(ps, "comm"), column(ps, "args")], { concurrency: 2 })
        if (args.size === 0) return yield* new ProcessesUnreadable({ message: "ps listed no process" })
        return [...args].map(([pid, line]): ProcessInfo => ({ pid, name: names.get(pid) ?? "", args: line }))
      }),
    }),
  )
