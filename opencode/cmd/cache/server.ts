/**
 * The cache mod's server plugin: the request ledger. The composition root of
 * the server half (the TUI half is `tui.tsx`). It fingerprints each model
 * request a session sends (`@dotfiles/opencode-cache/fingerprint`: the tools,
 * the system prompt by paragraph, each message part, hashed), joins it to the
 * step's usage when the step ends, and judges it against the session's request
 * before (`@dotfiles/opencode-cache/request-log`): a hit, or a miss by expiry,
 * a pool login move, a compaction, a changed prefix (naming the first segment
 * that changed and about how many tokens in), or an unchanged prefix the cache
 * still lost. Each judged request is a line in the ledger
 * (`~/.cache/opencode-cache-ledger/ledger.jsonl`, `scripts/cache-ledger.ts`
 * sums it), and the TUI reads a session's causes over the
 * `dotfiles-opencode.cache` RPC.
 *
 * - `model.request` (a primary or compaction request): the pool's credential
 *   and cache-lifetime headers, kept for the session's next `http.request`
 *   (the auth plugin strips them before this plugin's `http.request` runs).
 * - `http.request` (a primary or compaction request): the body is read from a
 *   copy of the request and fingerprinted; the login is the pool's credential,
 *   the lifetime the body's cache markers' `ttl` (the pool's cache-lifetime
 *   header wins). The request itself is sent as it was.
 * - `session.step.ended`, `session.step.failed`, `session.compaction.ended`:
 *   the waiting request is judged with the usage the event carries, or dropped.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `dir`: the ledger's directory; default `~/.cache/opencode-cache-ledger`.
 * - `host`: the host name each line carries; default the machine's.
 */
import { hostname } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { lifetime, segments } from "@dotfiles/opencode-cache/fingerprint"
import * as LedgerFile from "@dotfiles/opencode-cache/filestore/request-log"
import * as Model from "@dotfiles/opencode-cache/model"
import { CACHE_LEDGER, StepsQuery, type Tokens } from "@dotfiles/opencode-cache/request-log"
import type { RequestLog } from "@dotfiles/opencode-cache/service"

/** The pool's header naming the login a request goes out on (cmd/pool); its auth plugin strips it later. */
export const CREDENTIAL_HEADER = "x-opencode-credential-id"
/** The pool's header naming the lifetime a request's cache is written for (cmd/pool). */
export const CACHE_TTL_HEADER = "x-opencode-cache-ttl"

const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

export const Options = Schema.Struct({
  dir: Schema.NonEmptyString.pipe(withDefault(LedgerFile.DEFAULT_DIR)),
  host: Schema.NonEmptyString.pipe(withDefault(hostname())),
})
export type Options = typeof Options.Type

/** The ledger as the plugin keeps it: the JSONL file in the options' directory. */
export const live = (options: Options): Layer.Layer<RequestLog> => LedgerFile.layer(join(options.dir, LedgerFile.FILE_NAME))

const decodeSteps = Schema.decodeUnknownOption(StepsQuery)

const tokensOf = (tokens: { readonly input: number; readonly cache: { readonly read: number; readonly write: number } }): Tokens => ({
  prompt: tokens.input + tokens.cache.read + tokens.cache.write,
  read: tokens.cache.read,
  write: tokens.cache.write,
})

/** The request's body as JSON, from a copy; undefined when it has none or it is not JSON. */
const bodyOf = (request: Request) =>
  Effect.promise(() =>
    request
      .clone()
      .text()
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined),
  )

const EVENTS = ["session.step.ended", "session.step.failed", "session.compaction.ended"] as const

/** The plugin on `ledger`: the JSONL file in OpenCode, memory in the seam test. */
export const make = (ledger: (options: Options) => Layer.Layer<RequestLog>) =>
  Plugin.define({
    id: "dotfiles-opencode.cache",
    effect: Effect.fn("Cache.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.cache: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(Model.layer(options.host).pipe(Layer.provide(ledger(options))))
      const recorder = Context.get(services, Model.Recorder)

      // A title's or a generate call's request runs on its own prompt, outside the conversation's cache.
      const conversational = (kind: string) => kind === "primary" || kind === "compaction"
      // The pool names a request's login and lifetime in `model.request`, which runs for every plugin before any
      // `http.request`; the auth plugin's `http.request`, set up before this one, strips both headers. So they are
      // read here, after the pool's (set up before this one too), and joined to the session's next request.
      const placed = new Map<string, { readonly login?: string; readonly ttl?: string }>()
      const nonEmpty = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value.trim())
      yield* ctx.session.hook("model.request", (event) =>
        Effect.sync(() => {
          if (!conversational(event.kind)) return
          const login = nonEmpty(event.headers[CREDENTIAL_HEADER])
          const ttl = nonEmpty(event.headers[CACHE_TTL_HEADER])
          placed.set(event.sessionID, { ...(login === undefined ? {} : { login }), ...(ttl === undefined ? {} : { ttl }) })
        }),
      )
      yield* ctx.session.hook("http.request", (event) => {
        if (!conversational(event.kind)) return Effect.void
        const pool = placed.get(event.sessionID)
        placed.delete(event.sessionID)
        return bodyOf(event.request).pipe(
          Effect.flatMap((body) => {
            const found = segments(body)
            if (found.length === 0) return Effect.void
            // Headers still on the request: this hook ran before the auth plugin's, or no auth plugin strips them.
            const login = nonEmpty(event.request.headers.get(CREDENTIAL_HEADER) ?? undefined) ?? pool?.login
            const ttl = nonEmpty(event.request.headers.get(CACHE_TTL_HEADER) ?? undefined) ?? pool?.ttl
            return recorder.sent(event.sessionID, {
              kind: event.kind === "compaction" ? "compaction" : "primary",
              agent: event.agent,
              model: `${event.model.providerID}/${event.model.id}`,
              ...(login === undefined ? {} : { login }),
              ttlMs: lifetime(body, ttl).ttlMs,
              segments: found,
            })
          }),
        )
      })

      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: [...EVENTS] }).pipe(
          Stream.runForEach((event) => {
            if (event.type === "session.step.ended")
              return recorder.stepEnded(event.data.sessionID, event.data.assistantMessageID, tokensOf(event.data.tokens))
            if (event.type === "session.step.failed") return recorder.stepFailed(event.data.sessionID)
            // A compaction that reported no usage leaves nothing to judge: its request is dropped.
            const tokens = event.data.tokens
            return tokens === undefined ? recorder.stepFailed(event.data.sessionID) : recorder.compacted(event.data.sessionID, tokensOf(tokens))
          }),
          Effect.ignoreCause,
        ),
        { startImmediately: true },
      )

      // A malformed question names no session: it has no steps.
      yield* ctx.rpc
        .register(CACHE_LEDGER, {
          steps: (input) => Option.match(decodeSteps(input), { onNone: () => Effect.succeed({ steps: [] }), onSome: ({ sessionID }) => recorder.steps(sessionID) }),
        })
        .pipe(Effect.orDie)
    }),
  })

export default make(live)
