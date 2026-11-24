import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { argv } from "bun"
import { Console, Data, Effect, Option, Path, Schema } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { agentArgs, ROOT, staleMessage } from "../agents.ts"
import { checkoutAgents, scratchAgents, writtenAgents } from "../../tests/agent-fixture.ts"
import { readScratchFileSync, scratchExistsSync, scratchInput } from "../../tests/read-path.ts"

const Arguments = Schema.fromJsonString(Schema.Array(Schema.String))
class FixtureCheck extends Data.TaggedError("FixtureCheck") {}

BunRuntime.runMain(Effect.gen(function* () {
  const request = yield* Schema.decodeUnknownEffect(Arguments)(readScratchFileSync(argv[2] || "", "utf8"))
  const args = agentArgs(request)
  if (!args.check) return yield* new FixtureCheck()
  const path = yield* Path.Path
  const root = args.root && scratchInput(args.root) || ROOT
  const built = (args.source && scratchAgents(root, args.source, path)) || checkoutAgents(root)
  const written = readWritten(Option.fromUndefinedOr(args.root), built.path)
  const message = staleMessage(built, Option.getOrUndefined(written))
  if (message) {
    yield* Console.error(message)
    return yield* new FixtureCheck()
  }
}).pipe(Effect.provide(BunServices.layer)), { disableErrorReporting: true })

function readWritten(root: Option.Option<string>, file: string) {
  if (Option.isNone(root)) return Option.some(writtenAgents())
  if (scratchExistsSync(file)) return Option.some(readScratchFileSync(file, "utf8"))
  return Option.none<string>()
}
