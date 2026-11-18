/**
 * The queue as an OpenCode server plugin. The composition root: it decodes the
 * options, builds the queue model (`@dotfiles/opencode-queue/model`) on its
 * file store, registers the `queue` tool and answers the queue RPC
 * (`@dotfiles/opencode-queue/queue`, `QUEUE`) the sidebar reads.
 *
 * - `queue({ set } | { upsert?, remove? })` changes the calling session's
 *   queue and answers with it. A subagent keeps its own queue; the sidebar
 *   shows the root session's. The tool is an ordinary tool, so a kernel cell
 *   reaches it as `tools.queue(...)`; such a call leaves no tool part in the
 *   transcript, which is why the queue lives in the store and not in parts.
 * - `get({ sessionID })` answers `{ revision, items }`; the revision goes up
 *   with every change, so a reader polls cheaply.
 * - A deleted session's queue goes.
 * - Every few minutes a sweep (`@dotfiles/opencode-queue/fresh`) reads this
 *   location's recently active root sessions' queues and sends a session whose
 *   items look stale one short note asking its agent to check them: at most
 *   one an hour per session, never changing a queue itself.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `dir`: where the queues are kept, default `$XDG_STATE_HOME/opencode-queue`
 *   (`~/.local/state/opencode-queue`), one JSON file per session.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { join } from "node:path"
import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { DESCRIPTION, listing } from "@dotfiles/opencode-queue/description"
import * as FileStore from "@dotfiles/opencode-queue/filestore/store"
import * as Fresh from "@dotfiles/opencode-queue/fresh"
import * as Model from "@dotfiles/opencode-queue/model"
import * as Host from "@dotfiles/opencode-queue/opencode/host"
import { explain, QUEUE, QueueInput, type Rejection } from "@dotfiles/opencode-queue/queue"
import type { QueueStore, QueueUnreadable, QueueUnwritable } from "@dotfiles/opencode-queue/service"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const stateHome = () => TuiDirs.dirs().state

export const Options = Schema.Struct({
  dir: Schema.NonEmptyString.pipe(withDefault(join(stateHome(), "opencode-queue"))),
})
export type Options = typeof Options.Type

/** The live store: a JSON file per session under `dir`. */
export const live = (options: Options): Layer.Layer<QueueStore> => FileStore.layer(options.dir)

/** What the agent reads when a change fails: why it was refused, or what went wrong with the store. */
const messageOf = (failure: Rejection | QueueUnreadable | QueueUnwritable) => {
  if (failure._tag === "QueueUnreadable") return `The queue could not be read: ${failure.message}`
  if (failure._tag === "QueueUnwritable") return `The queue could not be saved: ${failure.message}`
  return explain(failure)
}

const sessionOf = (input: unknown) =>
  typeof input === "object" && input !== null && "sessionID" in input && typeof input.sessionID === "string" ? input.sessionID : ""

/** The plugin on `externals`: the file store in OpenCode, the memory store in the seam test. */
export const make = (externals: (options: Options) => Layer.Layer<QueueStore>) =>
  Plugin.define({
    id: "dotfiles-opencode.queue",
    effect: Effect.fn("Queue.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.queue: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // One store for the model and the sweep, so the sweep reads what the tool wrote.
      const store = Layer.succeedContext(yield* Layer.build(externals(options)))
      const queue = Context.get(yield* Layer.build(Model.layer.pipe(Layer.provide(store))), Model.QueueModel)

      // A queue that cannot be read fails the call, and the sidebar keeps what it drew.
      yield* ctx.rpc.register(QUEUE, { get: (input) => queue.get(sessionOf(input)).pipe(Effect.orDie) }).pipe(Effect.orDie)

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "queue",
          description: DESCRIPTION,
          input: QueueInput,
          // A direct tool beside the others, so it is offered without code mode and reached from a kernel cell.
          options: { codemode: false },
          execute: (input, context) =>
            queue.change(context.sessionID, input).pipe(
              Effect.map((snapshot) => ({ content: [{ type: "text" as const, text: listing(snapshot.items) }] })),
              Effect.mapError((failure) => new Tool.Error({ message: messageOf(failure), error: failure })),
            ),
        })
      })

      // A deleted session's queue goes.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
          Stream.runForEach((event) => queue.forget(event.data.sessionID).pipe(Effect.ignoreCause)),
          Effect.ignoreCause,
        ),
      )

      // The staleness sweep, last and on its own fiber: nothing of it runs or can fail before the tool and the RPC
      // answer. A pass every few minutes after a first wait, each on its own, so a failure is logged and skips only it.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const freshness = Context.get(yield* Layer.build(Fresh.layer.pipe(Layer.provide(Host.fromContext(ctx)), Layer.provide(store))), Fresh.Freshness)
          yield* Effect.sleep(Fresh.FIRST_AFTER)
          yield* freshness.sweep.pipe(
            Effect.ignoreCause({ log: "Warn", message: "queue: a staleness pass failed" }),
            Effect.repeat(Schedule.spaced(Fresh.SWEEP_EVERY)),
          )
        }).pipe(Effect.ignoreCause({ log: "Warn", message: "queue: the staleness sweep stopped" })),
      )
    }),
  })

export default make(live)
