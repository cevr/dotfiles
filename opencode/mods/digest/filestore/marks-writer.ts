// A test's writer process: appends `count` marks and one rename to the marks store in `dir`, as a second OpenCode
// server on the host would. Run by marks.test.ts as `bun marks-writer.ts <dir> <writer> <count>`.
import { Effect } from "effect"
import { markOf, nameOf } from "../marks.ts"
import { make } from "./marks.ts"

const [dir = "", writer = "w", count = "0"] = Bun.argv.slice(2)
const store = make(dir)
const T = 1_767_225_600_000

await Effect.runPromise(
  Effect.forEach(
    Array.from({ length: Number(count) }, (_, at) => at),
    (at) => store.append(markOf(`${writer}:${at}`, T + at, "read")),
    { concurrency: 4, discard: true },
  ),
)
await Effect.runPromise(store.append(nameOf(writer, `Project ${writer}`, T)))
