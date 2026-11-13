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
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `dir`: where the queues are kept, default `$XDG_STATE_HOME/opencode-queue`
 *   (`~/.local/state/opencode-queue`), one JSON file per session.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { join } from "node:path"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { DESCRIPTION, listing } from "@dotfiles/opencode-queue/description"
import * as FileStore from "@dotfiles/opencode-queue/filestore/store"
import * as Model from "@dotfiles/opencode-queue/model"
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
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(externals(options))))
      const queue = Context.get(services, Model.QueueModel)

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

      // A queue that cannot be read fails the call, and the sidebar keeps what it drew.
      yield* ctx.rpc.register(QUEUE, { get: (input) => queue.get(sessionOf(input)).pipe(Effect.orDie) }).pipe(Effect.orDie)
    }),
  })

export default make(live)
