// A live tab over the DevTools protocol: a WebSocket to one page of a
// headless browser this viewer started. Each command waits for its answer;
// screencast frames are acknowledged as they come (so the browser keeps
// sending) and only the newest waits to be drawn; the main frame's
// navigations give the page's address. When the socket closes (the browser
// died or was killed) every wait fails with why.
import { Cause, Deferred, Effect, Exit, Option, Queue, Schema, type Scope } from "effect"
import { type Command, type Frame, type Json, ShotFailed, type Tab } from "../service.ts"

/** How long one command may take before it is taken as failed. */
const COMMAND_MS = 10_000

/** A message from the browser: an answer (`id` with `result` or `error`) or an event (`method` with `params`). */
const Message = Schema.Struct({
  id: Schema.optional(Schema.Int),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))

const ScreencastFrame = Schema.Struct({
  data: Schema.String,
  sessionId: Schema.Int,
  metadata: Schema.Struct({ deviceWidth: Schema.Number, deviceHeight: Schema.Number }),
})
const decodeFrame = Schema.decodeUnknownOption(ScreencastFrame)

const Navigated = Schema.Struct({ frame: Schema.Struct({ url: Schema.String, parentId: Schema.optional(Schema.String) }) })
const decodeNavigated = Schema.decodeUnknownOption(Navigated)
const WithinDocument = Schema.Struct({ url: Schema.String })
const decodeWithin = Schema.decodeUnknownOption(WithinDocument)

const Evaluated = Schema.Struct({ result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }) })
const decodeEvaluated = Schema.decodeUnknownOption(Evaluated)

/**
 * The tab on the page whose debugger is at `socket`, for `url` (named in
 * errors). The socket closes with the scope.
 */
export const connect = (socket: string, url: string): Effect.Effect<Tab, ShotFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const failed = (message: string) => new ShotFailed({ url, message })
    const frames = yield* Queue.sliding<Frame, ShotFailed>(1)
    const urls = yield* Queue.sliding<string, ShotFailed>(1)
    const waiting = new Map<number, Deferred.Deferred<unknown, ShotFailed>>()
    const next = { id: 0 }
    const ws = yield* Effect.acquireRelease(
      Effect.callback<WebSocket, ShotFailed>((resume) => {
        const opening = new WebSocket(socket)
        opening.addEventListener("open", () => resume(Effect.succeed(opening)), { once: true })
        opening.addEventListener("error", () => resume(Effect.fail(failed(`cannot reach the browser's debugger at ${socket}`))), { once: true })
      }),
      (open) => Effect.sync(() => open.close()),
    )
    const send = (method: string, params: Json) =>
      Effect.gen(function* () {
        next.id += 1
        const id = next.id
        const answer = yield* Deferred.make<unknown, ShotFailed>()
        waiting.set(id, answer)
        ws.send(JSON.stringify({ id, method, params }))
        return yield* Deferred.await(answer).pipe(
          Effect.timeoutOrElse({ duration: COMMAND_MS, orElse: () => Effect.fail(failed(`the browser did not answer ${method}`)) }),
          Effect.ensuring(Effect.sync(() => waiting.delete(id))),
        )
      })
    ws.addEventListener("message", (event) => {
      Option.map(decodeMessage(String(event.data)), (message) => {
        Option.map(Option.fromUndefinedOr(message.id), (id) =>
          Option.map(Option.fromUndefinedOr(waiting.get(id)), (answer) =>
            Deferred.doneUnsafe(
              answer,
              Option.match(Option.fromUndefinedOr(message.error), {
                onNone: () => Effect.succeed(message.result),
                onSome: (error) => Effect.fail(failed(error.message)),
              }),
            ),
          ),
        )
        if (message.method === "Page.screencastFrame") {
          Option.map(decodeFrame(message.params), (frame) => {
            ws.send(JSON.stringify({ id: 0, method: "Page.screencastFrameAck", params: { sessionId: frame.sessionId } }))
            Queue.offerUnsafe(frames, { data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight })
          })
        }
        if (message.method === "Page.frameNavigated") {
          Option.map(
            Option.filter(decodeNavigated(message.params), (navigated) => Option.isNone(Option.fromUndefinedOr(navigated.frame.parentId))),
            (navigated) => Queue.offerUnsafe(urls, navigated.frame.url),
          )
        }
        if (message.method === "Page.navigatedWithinDocument") Option.map(decodeWithin(message.params), (within) => Queue.offerUnsafe(urls, within.url))
      })
    })
    ws.addEventListener("close", () => {
      const gone = failed("the browser closed")
      Queue.failCauseUnsafe(frames, Cause.fail(gone))
      Queue.failCauseUnsafe(urls, Cause.fail(gone))
      for (const answer of waiting.values()) Deferred.doneUnsafe(answer, Exit.fail(gone))
    })
    return {
      frame: Queue.take(frames),
      url: Queue.take(urls),
      send: (commands: ReadonlyArray<Command>) => Effect.forEach(commands, (command) => send(command.method, command.params), { discard: true }),
      ask: (expression: string) =>
        Effect.map(send("Runtime.evaluate", { expression, returnByValue: true }), (answer) =>
          Option.getOrUndefined(Option.flatMap(decodeEvaluated(answer), (evaluated) => Option.fromUndefinedOr(evaluated.result.value))),
        ),
    } satisfies Tab
  })
