/**
 * The digest mod's server half: an OpenCode server plugin that owns this host's digest log
 * (`~/.local/state/opencode-digest/events-YYYY-MM.jsonl`) and answers its RPC (`DIGEST` in
 * `@dotfiles/opencode-digest/event`). Every other plugin that writes a fact (orchestrate, queue, questions)
 * sends its line here through `ctx.rpc(DIGEST).append({ line })`, behind `@dotfiles/opencode-digest/relay`.
 * A line that does not decode as an event, or is over MAX_LINE bytes, is refused: the log holds only lines a
 * reader can fold.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `dir`: the log's directory, default `$XDG_STATE_HOME/opencode-digest` (`~/.local/state/opencode-digest`).
 */
import { Plugin } from "@opencode/plugin/effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AppendInput, byteLength, decodeLine, DIGEST, MAX_LINE } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import { DigestLines, DigestUnwritable } from "@dotfiles/opencode-digest/service"

/** The options; `dir` falls back to the host's state directory, read when the plugin starts. */
export const Options = Schema.Struct({ dir: Schema.optionalKey(Schema.NonEmptyString) })
export type Options = typeof Options.Type

/** The log's directory: the option, else the host's state directory's `opencode-digest`. */
export const dirOf = (options: Options): string => Option.getOrElse(Option.fromUndefinedOr(options.dir), () => `${TuiDirs.dirs().state}/opencode-digest`)

/** The live log: the month files in the options' directory. */
export const live = (options: Options): Layer.Layer<DigestLines> => FileLog.layer(dirOf(options))

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

/** The plugin on `externals`: the file log in OpenCode, the memory log in the seam test and the simulations. */
export const make = (externals: (options: Options) => Layer.Layer<DigestLines>) =>
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
    }),
  })

export default make(live)
