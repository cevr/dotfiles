/**
 * The simulated server's clock, from a scenario: the fork's Drive backend
 * answers `clock.advance` (packages/simulation/src/backend/clock.ts), which
 * moves the time every fiber of the server reads (its plugins' timers too) and
 * wakes the sleeps it passes. Real time keeps flowing besides, so a scenario
 * advances only past the waits it means to skip.
 *
 * The server is the run's one `serve --service` process: its Drive manifest is
 * `<artifacts>/drive/<instance>-service-<id>.json`, and its `endpoints.backend`
 * is the socket the advance goes to (a second connection beside the driver's,
 * which a backend allows).
 *
 * @module
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Socket } from "effect/socket"

export class SimClockError extends Schema.TaggedError<SimClockError>()("SimClockError", {
  message: Schema.String,
}) {}

const Manifest = Schema.fromJsonString(Schema.Struct({ endpoints: Schema.Struct({ backend: Schema.String }) }))
const Json = Schema.fromJsonString(Schema.Unknown)

/** A JSON-RPC answer: its id, and its result or its error. */
const Answered = Schema.Struct({ id: Schema.Number, result: Schema.Unknown })
const Refused = Schema.Struct({ id: Schema.Union([Schema.Number, Schema.Null]), error: Schema.Unknown })
const Reply = Schema.fromJsonString(Schema.Union([Answered, Refused]))
type Reply = typeof Reply.Type

const Advanced = Schema.Struct({ now: Schema.Number })

const handshake = {
  jsonrpc: "2.0",
  id: 0,
  method: "simulation.handshake",
  params: {
    client: { name: "dotfiles-scenario", version: "1" },
    expectedRole: "backend",
    offeredVersions: [1],
    requiredCapabilities: ["clock.advance"],
    optionalCapabilities: [],
  },
}

/** The backend endpoint of the run's server, from its one Drive manifest. */
const backendOf = Effect.fn("SimClock.backendOf")(function* (artifacts: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const drive = path.join(artifacts, "drive")
  const manifests = (yield* fs.readDirectory(drive)).filter((name) => name.includes("-service-") && name.endsWith(".json"))
  const only = Arr.head(manifests).pipe(Option.filter(() => manifests.length === 1))
  const name = yield* Option.match(only, {
    onNone: () => Effect.fail(new SimClockError({ message: `expected one service manifest in ${drive}, found ${manifests.length}` })),
    onSome: Effect.succeed,
  })
  const manifest = yield* Schema.decodeEffect(Manifest)(yield* fs.readFileString(path.join(drive, name)))
  return manifest.endpoints.backend
})

/** Reads replies off the socket until the one for `id`. */
const replyTo = (pull: Effect.Effect<ReadonlyArray<string>, Socket.SocketError>, id: number): Effect.Effect<Reply, Socket.SocketError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.forEach(yield* pull, (chunk) => Schema.decodeEffect(Reply)(chunk))
    return yield* Option.match(
      Arr.findFirst(decoded, (reply) => reply.id === id),
      { onNone: () => replyTo(pull, id), onSome: Effect.succeed },
    )
  })

/** The result of a reply the server answered, or a SimClockError naming what it refused. */
const resultOf = (reply: Reply, what: string) =>
  Option.match(Schema.decodeUnknownOption(Answered)(reply), {
    onSome: (ok) => Effect.succeed(ok.result),
    onNone: () => Schema.encodeEffect(Json)(reply).pipe(Effect.flatMap((text) => Effect.fail(new SimClockError({ message: `the server refused ${what}: ${text}` })))),
  })

/**
 * Moves the run's server clock forward by `ms`, and returns its new time in epoch ms.
 * Fails when the server has no simulated clock (a fork without it, or a server outside drive mode).
 */
export const advance = Effect.fn("SimClock.advance")(
  function* (artifacts: string, ms: number) {
    const socket = yield* Socket.makeWebSocket(yield* backendOf(artifacts))
    const pull = yield* Socket.readerString(socket)
    const writer = yield* socket.writer
    yield* writer.write(yield* Schema.encodeEffect(Json)(handshake))
    yield* resultOf(yield* replyTo(pull, 0), "the clock handshake")
    yield* writer.write(yield* Schema.encodeEffect(Json)({ jsonrpc: "2.0", id: 1, method: "clock.advance", params: { ms } }))
    const result = yield* resultOf(yield* replyTo(pull, 1), "clock.advance")
    return (yield* Schema.decodeUnknownEffect(Advanced)(result)).now
  },
  Effect.scoped,
  Effect.provide(Layer.merge(BunServices.layer, Socket.layerWebSocketConstructorGlobal)),
)
