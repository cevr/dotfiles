// The memory line the simulated tests use keeps the MainLine laws (laws.ts) git's adapter keeps: each repository the
// laws ask for is a line as git would hold it, under the same default-branch rule (main or master, origin's first).
import { Effect, Option } from "effect"
import { mainLineLaws } from "../laws.ts"
import * as MemoryMainLine from "./main-line.ts"

mainLineLaws(
  "the memory MainLine",
  Effect.sync(() => {
    const branches = new Map<string, MemoryMainLine.Branch>()
    const count = { made: 0 }
    const sha = () => {
      count.made += 1
      return count.made.toString(16).padStart(40, "a")
    }
    return {
      layer: MemoryMainLine.layer((checkout) => Option.fromUndefinedOr(branches.get(checkout))),
      repository: (name: string, branch: string, merges: number) =>
        Effect.sync(() => {
          const checkout = `/memory/${name}`
          const line: Array<MemoryMainLine.Entry> = [{ sha: sha(), subject: "root", merged: [] }]
          const tips = Array.from({ length: merges }, (_, n) => {
            const tip = sha()
            line.push({ sha: sha(), subject: `Merge branch 'feat/u${n}'`, merged: [tip] })
            return tip
          })
          // As git reads it: a default branch only when it is main or master.
          if (branch === "main" || branch === "master") branches.set(checkout, { branch, line })
          return { checkout, line: line.map((entry) => entry.sha), tips }
        }),
      // origin's default branch lagging main: the line as origin has it, up to that commit.
      origin: (checkout: string, at: string) =>
        Effect.sync(() =>
          Option.map(Option.fromUndefinedOr(branches.get(checkout)), (branch) =>
            branches.set(checkout, { ...branch, line: branch.line.slice(0, branch.line.findIndex((entry) => entry.sha === at) + 1) }),
          ),
        ),
      plain: Effect.succeed("/memory/plain"),
    }
  }),
)
