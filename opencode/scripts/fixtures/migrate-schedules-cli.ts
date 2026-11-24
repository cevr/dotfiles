import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { argv } from "bun"
import { Clock, Console, Data, Effect, Schema } from "effect"
import { readScratchFileSync, scratchInput } from "../../tests/read-path.ts"
import { decodeRows, parseArgs, runMigration } from "../migrate-schedules.ts"

const Arguments = Schema.fromJsonString(Schema.Array(Schema.String))
class FixtureMigration extends Data.TaggedError("FixtureMigration") {}

// The existing CLI takes its normal argument vector; this host allows only the rows-file dry run.
BunRuntime.runMain(Effect.gen(function* () {
  const request = yield* Schema.decodeUnknownEffect(Arguments)(readScratchFileSync(argv[2] || "", "utf8"))
  const args = parseArgs(request, {})
  if (args.apply || !args.rows) return yield* new FixtureMigration()
  const file = scratchInput(args.rows)
  const rows = decodeRows(readScratchFileSync(file, "utf8"))
  const now = yield* Clock.currentTimeMillis
  const out: string[] = []
  const applied = runMigration({ ...args, prompts: scratchInput(args.prompts) }, now, rows, {
    out: (line) => { out.push(line) },
    apply: () => new FixtureMigration(),
  })
  if (applied) return yield* applied
  for (const line of out) yield* Console.log(line)
}))
