// Herdr over its Unix socket: one connection per request, a JSON line out and
// the first reply line back, within a timeout. herdr's socket protocol is
// newline-delimited JSON, `{"id","method","params"}` answered by
// `{"id","result"}` or `{"id","error":{"code","message"}}` (socket-api.mdx).
import { Effect, Layer, Option, Schema } from "effect"
import { Herdr, HerdrRefused, HerdrUnreachable } from "../service.ts"

export interface Options {
  /** The socket's path: `HERDR_SOCKET_PATH`. */
  readonly path: string
  /** How long one request may take, connect to reply. */
  readonly timeoutMillis: number
}

/** The longest reply line read before giving up on it. */
const REPLY_LIMIT = 65_536

const Reply = Schema.Struct({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
})
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))

/** Writes `line` to the socket at `path` and resumes with the first line it answers. */
const exchange = (path: string, line: string) =>
  Effect.callback<string, HerdrUnreachable>((resume) => {
    const bytes = new TextEncoder().encode(line)
    const decoder = new TextDecoder()
    let written = 0
    let buffer = ""
    let done = false
    let open: { end: () => void } | undefined
    const finish = (outcome: Effect.Effect<string, HerdrUnreachable>) => {
      if (done) return
      done = true
      open?.end()
      resume(outcome)
    }
    const fail = (message: string) => finish(Effect.fail(new HerdrUnreachable({ message })))
    const flush = (socket: { write: (data: Uint8Array) => number }) => {
      if (written < bytes.length) written += Math.max(0, socket.write(bytes.subarray(written)))
    }
    Bun.connect({
      unix: path,
      socket: {
        open: flush,
        drain: flush,
        data(_socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true })
          const end = buffer.indexOf("\n")
          if (end >= 0) finish(Effect.succeed(buffer.slice(0, end)))
          else if (buffer.length > REPLY_LIMIT) fail("herdr's reply exceeded the limit")
        },
        close: () => fail("herdr closed before replying"),
        error: (_socket, error) => fail(`herdr's socket failed: ${error.message}`),
        connectError: (_socket, error) => fail(`herdr's socket could not be reached: ${error.message}`),
      },
    }).then(
      (socket) => {
        open = socket
        if (done) socket.end()
      },
      (error: unknown) => fail(`herdr's socket could not be reached: ${error instanceof Error ? error.message : String(error)}`),
    )
    return Effect.sync(() => {
      done = true
      open?.end()
    })
  })

export const layer = (options: Options) =>
  Layer.sync(Herdr, () => {
    let next = 0
    const send = (method: string, params: object) =>
      Effect.gen(function* () {
        next += 1
        const id = `dotfiles-opencode-herdr:${next}`
        const line = yield* exchange(options.path, `${JSON.stringify({ id, method, params })}\n`)
        const reply = decodeReply(line)
        if (Option.isNone(reply) || reply.value.id !== id) return yield* new HerdrUnreachable({ message: `herdr answered ${method} with something else` })
        const error = reply.value.error
        if (error !== undefined) return yield* new HerdrRefused({ method, code: error.code, message: error.message })
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.timeoutMillis,
          orElse: () => Effect.fail(new HerdrUnreachable({ message: `herdr did not answer ${method} within ${options.timeoutMillis} ms` })),
        }),
      )
    return Herdr.of({
      report: (params) => send("pane.report_agent", params),
      reportMetadata: (params) => send("pane.report_metadata", params),
      release: (params) => send("pane.release_agent", params),
    })
  })
