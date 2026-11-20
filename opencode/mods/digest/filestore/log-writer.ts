// A test's writer process: appends `count` long lines to the log in `dir` through the file store, as one more
// OpenCode server on the host would. Run by log.test.ts as `bun log-writer.ts <dir> <writer> <count>`.
import { Effect } from "effect"
import { DigestEvent, encodeLine, VERSION } from "../event.ts"
import { make } from "./log.ts"

const [dir = "", writer = "w", count = "0"] = Bun.argv.slice(2)
const log = make(dir)
const T = 1_767_225_600_000

const lineOf = (at: number) =>
  encodeLine(DigestEvent.cases.Check.make({ v: VERSION, t: T + at, root: writer, ok: true, text: `${writer}:${at}:${"x".repeat(3_900)}` }))

await Effect.runPromise(Effect.forEach(Array.from({ length: Number(count) }, (_, at) => at), (at) => log.append(lineOf(at), T), { concurrency: 4, discard: true }))
