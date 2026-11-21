/**
 * The digest mod's server half: an OpenCode server plugin that owns this host's digest log
 * (`~/.local/state/opencode-digest/events-YYYY-MM.jsonl`) and answers its RPC (`DIGEST` in
 * `@dotfiles/opencode-digest/event`). Every other plugin that writes a fact (orchestrate, queue, questions)
 * sends its line here through `ctx.rpc(DIGEST).append({ line })`, behind `@dotfiles/opencode-digest/relay`.
 * A line that does not decode as an event, or is over MAX_LINE bytes, is refused: the log holds only lines a
 * reader can fold.
 *
 * It also serves the digest's page on http://127.0.0.1:8240 (`@dotfiles/opencode-digest/http/listener`): the
 * built page, the view folded from the log and the owner's marks at each request (no model call, nothing
 * polled), and his marks (read, unread, Later, a project's name) kept beside the log (`filestore/marks`).
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `dir`: the log's directory, default `$XDG_STATE_HOME/opencode-digest` (`~/.local/state/opencode-digest`).
 * - `timezone` (digest.timezone): the zone Later's morning (6:00 AM) and the page's times are in, default the host's.
 * - `port`: the page's port on 127.0.0.1, default 8240.
 */
import { Plugin } from "@opencode/plugin/effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Clock, Context, Effect, Layer, Option, Path, Schema, type Scope } from "effect"
import { AppendInput, byteLength, decodeLine, decodeLines, DIGEST, MAX_LINE } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import * as FileMarks from "@dotfiles/opencode-digest/filestore/marks"
import { EMPTY, fold } from "@dotfiles/opencode-digest/fold"
import * as Listener from "@dotfiles/opencode-digest/http/listener"
import { pageOf } from "@dotfiles/opencode-digest/messages"
import { DigestLines, DigestUnwritable } from "@dotfiles/opencode-digest/service"
import { encodeView, viewOf } from "@dotfiles/opencode-digest/view"
import { hostZone, isZone } from "@dotfiles/opencode-digest/zone"

/** The options; `dir` falls back to the host's state directory, read when the plugin starts. */
export const Options = Schema.Struct({
  dir: Schema.optionalKey(Schema.NonEmptyString),
  timezone: Schema.optionalKey(Schema.String.check(Schema.makeFilter((zone) => isZone(zone) || `"${zone}" is not a time zone`))),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }))),
})
export type Options = typeof Options.Type

/** The log's directory: the option, else the host's state directory's `opencode-digest`. */
export const dirOf = (options: Options): string => Option.getOrElse(Option.fromUndefinedOr(options.dir), () => `${TuiDirs.dirs().state}/opencode-digest`)

/** `digest.timezone`: the option, else the host's zone. */
export const zoneOf = (options: Options): string => Option.getOrElse(Option.fromUndefinedOr(options.timezone), hostZone)

/** The live log: the month files in the options' directory. */
export const live = (options: Options): Layer.Layer<DigestLines> => FileLog.layer(dirOf(options))

/** The built page, committed beside the digest mod (`mods/digest/page/dist`). */
const DIST = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("../../mods/digest/page/dist", import.meta.url))).pipe(Effect.provide(Path.layer), Effect.orDie)

/** The page's handlers over the log `lines` and the marks beside it. */
export const handlersOf = (options: Options, lines: DigestLines["Service"]): Listener.Handlers => {
  const marks = FileMarks.make(dirOf(options))
  const zone = zoneOf(options)
  return {
    view: Effect.gen(function* () {
      const log = decodeLines(yield* lines.read)
      const page = pageOf(fold(EMPTY, log.events), { names: new Map() })
      return encodeView(viewOf(page, yield* marks.read, yield* Clock.currentTimeMillis, zone))
    }),
    write: marks.append,
    now: Clock.currentTimeMillis,
    zone,
  }
}

/** The live page: the listener on 127.0.0.1, retrying while another instance holds the port. */
export const livePage = (options: Options, lines: DigestLines["Service"]): Effect.Effect<void, never, Scope.Scope> =>
  Effect.flatMap(DIST, (dist) => Listener.serve(Option.getOrElse(Option.fromUndefinedOr(options.port), () => Listener.PORT), handlersOf(options, lines), dist))

const decodeInput = Schema.decodeUnknownEffect(AppendInput)

/** A malformed option: the plugin does not start. */
class InvalidOptions extends Schema.TaggedError<InvalidOptions>()("InvalidOptions", { message: Schema.String }) {}

/** One line the RPC was given (`input`, as decoded), checked: it must decode as an event and fit MAX_LINE. */
const checked = (input: Effect.Effect<AppendInput, Schema.SchemaError>) =>
  input.pipe(
    Effect.mapError(() => new DigestUnwritable({ message: "append takes { line: string }" })),
    Effect.flatMap(({ line }) =>
      Option.match(Option.filter(decodeLine(line), () => byteLength(line) <= MAX_LINE && !line.includes("\n")), {
        onNone: () => Effect.fail(new DigestUnwritable({ message: "the line is not one digest event of at most 4,096 bytes" })),
        onSome: (event) => Effect.succeed({ line, t: event.t }),
      }),
    ),
  )

/** A page that serves nothing: the seam test's and the simulations', which never bind a port. */
const noPage = (): Effect.Effect<void, never, Scope.Scope> => Effect.void

/**
 * The plugin on `externals` and `page`: the file log and the live page in OpenCode, the memory log and no page in
 * the seam test and the simulations.
 */
export const make = (externals: (options: Options) => Layer.Layer<DigestLines>, page: typeof livePage = noPage) =>
  Plugin.define({
    id: "dotfiles-opencode.digest",
    effect: Effect.fn("Digest.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new InvalidOptions({ message: `dotfiles-opencode.digest: invalid options: ${error.message}` })),
        Effect.orDie,
      )
      const lines = Context.get(yield* Layer.build(externals(options)), DigestLines)
      // A refused line is answered as refused, so the writer's relay drops it; a line that cannot be written fails
      // the call, so the relay holds it and tries again.
      yield* ctx.rpc
        .register(DIGEST, {
          append: (input) =>
            Effect.matchEffect(checked(decodeInput(input)), {
              onFailure: (refused) => Effect.as(Effect.logWarning("digest: a line was refused", { reason: refused.message }), { refused: refused.message }),
              onSuccess: ({ line, t }) =>
                lines.append(line, t).pipe(
                  Effect.tapError((failure) => Effect.logWarning("digest: a line was not written", { reason: failure.message })),
                  Effect.as({}),
                  Effect.orDie,
                ),
            }),
        })
        .pipe(Effect.orDie)
      yield* Effect.forkScoped(page(options, lines))
    }),
  })

export default make(live, livePage)
