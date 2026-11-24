import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { argv } from "bun"
import { Clock, Console, Effect, Schema } from "effect"
import { readScratchFileSync, scratchInput } from "../../tests/read-path.ts"
import { runLimits } from "../pool-limits.ts"

const Arguments = Schema.fromJsonString(Schema.Struct({ args: Schema.Array(Schema.String), defaultFile: Schema.String }))

BunRuntime.runMain(Effect.gen(function* () {
  const request = yield* Schema.decodeUnknownEffect(Arguments)(readScratchFileSync(argv[2] || "", "utf8"))
  const now = yield* Clock.currentTimeMillis
  const out: string[] = []
  const errors: string[] = []
  const code = runLimits(request.args, {
    defaultFile: () => scratchInput(request.defaultFile),
    read: (file) => readScratchFileSync(file, "utf8"),
    now: () => now,
    out: (line) => { out.push(line) },
    error: (line) => { errors.push(line) },
  })
  for (const line of out) yield* Console.log(line)
  for (const line of errors) yield* Console.error(line)
  if (code !== 0) return yield* Effect.fail(code)
}), { disableErrorReporting: true })
