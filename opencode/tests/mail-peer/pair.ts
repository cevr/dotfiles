import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { argv, env } from "bun"
import { Console, Data, Effect, Layer, Schema } from "effect"
import { pair } from "../../cmd/mail/pair.ts"
import { fileOf, layerReading } from "../../mods/mail/filestore/pairs.ts"
import { liveNet } from "../../mods/mail/http/peers.ts"
import { tokens } from "../../mods/mail/node/keyed.ts"
import { matchingInput, readScratchFileSync, scratchInput } from "../read-path.ts"

const Args = Schema.fromJsonString(Schema.Array(Schema.String))
class PairFixtureFailed extends Data.TaggedError("PairFixtureFailed") {}

const pairingArgs = (args: ReadonlyArray<string>) => {
  const name = args.at(-1) || ""
  if (args.at(-2) !== "--name" || !/^[\w.-]+$/.test(name)) return false
  if (args[0] === "invite") return args.length === 3
  return args.length === 5 && args[0] === "join" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(args[1] || "") &&
    /^[\w-]+$/.test(args[2] || "")
}

BunRuntime.runMain(Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(Args)(readScratchFileSync(argv[2] || "", "utf8"))
  if (!pairingArgs(args)) return yield* new PairFixtureFailed()
  const file = scratchInput(fileOf(env))
  const store = layerReading(file, () => readScratchFileSync(file, "utf8"))
  const services = Layer.mergeAll(store, liveNet, tokens)
  const outcome = yield* pair(args, matchingInput("cmd/mail/pair.ts")).pipe(Effect.provide(services))
  if (outcome.ok) return yield* Console.log(outcome.out)
  yield* Console.error(outcome.error)
  return yield* new PairFixtureFailed()
}), { disableErrorReporting: true })
