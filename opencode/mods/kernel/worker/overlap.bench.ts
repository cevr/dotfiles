// How much a cell's tool calls overlap, on a scripted sample of cells run in a
// real worker: the idioms the old description taught (one await after
// another, Promise.all) beside the ones it teaches now (Promise.all past the
// in-flight limit, tools.map, a returned object of calls). Each call is an
// echo that takes 20 ms. Each row: whether the cell ran, its calls, the most
// in flight at once (counted here, host-side, so the same script measures a
// tree whose journal keeps no spans), the journal's own `concurrency` when it
// has one, and the wall time. `bun mods/kernel/worker/overlap.bench.ts`
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Json } from "../frame.ts"
import * as Operations from "../operations.ts"
import { Workers, type Cell } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import * as ProcessWorkers from "./workers.ts"

const sample: ReadonlyArray<readonly [string, string]> = [
  ["5 calls, one await after another", "for (const n of [1, 2, 3, 4, 5]) await tools.echo({ n })"],
  ["3 calls in Promise.all", "await Promise.all([1, 2, 3].map((n) => tools.echo({ n })))"],
  ["40 calls in Promise.all", "(await Promise.all(Array.from({ length: 40 }, (_, n) => tools.echo({ n })))).length"],
  ["40 calls in tools.map", "(await tools.map(Array.from({ length: 40 }, (_, n) => n), (n) => tools.echo({ n }))).length"],
  ["3 calls returned in an object", "({ a: tools.echo({ n: 1 }), b: tools.echo({ n: 2 }), c: tools.echo({ n: 3 }) })"],
]

const session = KernelSessionId.make("ses_overlap")
const directory = mkdtempSync(join(tmpdir(), "kernel-overlap-"))

const measure = (workers: Workers["Service"], source: string) =>
  Effect.gen(function* () {
    const journal = Operations.journal(() => Effect.void)
    let now = 0
    let most = 0
    let calls = 0
    const call: Cell["call"] = (name, input) =>
      journal
        .around(
          name,
          input,
          Effect.gen(function* () {
            calls++
            now++
            most = Math.max(most, now)
            yield* Effect.sleep("20 millis")
            now--
            return { content: input }
          }),
        )
        .pipe(Effect.map((outcome): Json => outcome.content))
    const from = performance.now()
    const result = yield* workers.evaluate(session, { source, tools: [{ id: "echo", description: "echoes" }], call })
    const shown = result.ok ? "ok" : `failed: ${result.display.split("\n")[0]}`
    const kept = journal.metadata()[Operations.CONCURRENCY_KEY as string] as Operations.Concurrency | undefined
    return { shown, calls, most, kept, ms: Math.round(performance.now() - from), pending: result.display.includes("Promise") }
  })

const rows = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const workers = yield* Workers
      yield* workers.start(session, directory)
      const rows: string[] = []
      for (const [name, source] of sample) {
        const row = yield* measure(workers, source)
        const journal = row.kept === undefined ? "-" : `${row.kept.maxInFlight}/${row.kept.calls}`
        rows.push(`| ${name} | ${row.shown}${row.pending ? " (shows pending promises)" : ""} | ${row.calls} | ${row.most} | ${journal} | ${row.ms} |`)
      }
      return rows
    }),
  ).pipe(Effect.provide(ProcessWorkers.layer({ timeoutMs: 30_000 }))),
)
rmSync(directory, { recursive: true, force: true })
console.log("| cell | result | calls | most in flight | journal max/calls | ms |\n| --- | --- | --- | --- | --- | --- |")
for (const row of rows) console.log(row)
