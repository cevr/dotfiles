/**
 * The code kernel as an OpenCode server plugin. The composition root: it decodes the options, builds the model
 * (`@dotfiles/opencode-kernel/model`) on one implementation of each contract
 * in `@dotfiles/opencode-kernel/service`, and registers the `kernel` tool.
 *
 * - `kernel({ code, reset? })` runs TypeScript in a Bun worker that lives as
 *   long as its session, so top-level bindings persist between calls. The
 *   result is what the code printed, then its last expression's value.
 * - Inside the code, `await tools.<id>(input)` runs another OpenCode tool
 *   (`@dotfiles/opencode-kernel/opencode/toolbox`); an image in its result
 *   reaches the cell as a marker.
 * - `attach(...paths)` in the code shows image files to the model: the result's
 *   content is the text, then one file part per image as a data URI, which
 *   OpenCode resizes to the model's limits. A path that is not an image, is
 *   missing or is over 20 MB is a line in the text.
 * - One worker per session, started on the first call. It is killed when the
 *   session is deleted, after `idleMs` without a call, on abort, and past the
 *   compute limit. After every call the bindings that hold data are stored
 *   under the session as structured clones (worker/codec.ts); a new
 *   worker starts with them, and `reset` drops them.
 * - With `codeOnly` (the default) the kernel is the agent's runtime, as Prime
 *   Agent's REPL is: the model is offered the kernel alone, its description
 *   lists every other tool on a line with its input (frozen per session at
 *   its first request; a later change in the tools is a message, never a new
 *   description: ../../mods/kernel/frozen.ts), and a cell's call runs through the
 *   registry's hooks, so `tools.subagent` passes the orchestrate guard, pace
 *   and Sabbath. Deny `kernel` to an agent to give it its usual tools. Needs
 *   the fork's `options.runtime`. The tools `direct` names are offered beside
 *   it with their own definitions (the runtime's `direct`), left off its
 *   list, and still reached from a cell; the set is frozen per session too.
 * - `tools.subagent(input)` in a cell resolves to a live handle whose methods
 *   wait on, read and stop the subagent (mods/kernel/worker/subagent-handle.ts),
 *   through the `subagents` tool the plugin adds beside the kernel: a session
 *   lists, reads, waits on and stops its own subagents, and only its own
 *   (mods/kernel/subagents.ts). A stop is the host's own session interrupt.
 * - Without `codeOnly` it is a direct tool beside the others (`codemode:
 *   false`), whose calls skip the hooks; with `denyExecute`, every agent the
 *   plugins define denies code mode's `execute`.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `idleMs`: kill a session's worker after this long without a call; default 1,800,000 (30 min).
 * - `timeoutMs`: a call's compute limit, paused while its tool calls run; default 30,000.
 * - `viewChars`: the characters of output the model sees per call; default 8,000.
 * - `codeOnly`: make the kernel the agents' only tool; default true.
 * - `denyExecute`: without `codeOnly`, deny code mode's `execute` to every agent; default true.
 * - `direct`: with `codeOnly`, the tool ids offered beside the kernel; default the memory tools (`DIRECT`).
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema, Scope, Stream } from "effect"
import { description, KernelInput } from "@dotfiles/opencode-kernel/description"
import * as Frozen from "@dotfiles/opencode-kernel/frozen"
import type { Reply } from "@dotfiles/opencode-kernel/attachment"
import * as FileStoreFiles from "@dotfiles/opencode-kernel/filestore/files"
import * as Model from "@dotfiles/opencode-kernel/model"
import * as Operations from "@dotfiles/opencode-kernel/operations"
import type { Files, Sessions, Snapshots, Workers } from "@dotfiles/opencode-kernel/service"
import { KernelSessionId } from "@dotfiles/opencode-kernel/session"
import * as OpenCodeSessions from "@dotfiles/opencode-kernel/opencode/sessions"
import * as OpenCodeSnapshots from "@dotfiles/opencode-kernel/opencode/snapshots"
import * as OpenCodeSubagents from "@dotfiles/opencode-kernel/opencode/subagents"
import * as OpenCodeToolbox from "@dotfiles/opencode-kernel/opencode/toolbox"
import * as ProcessWorkers from "@dotfiles/opencode-kernel/worker/workers"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

type SessionID = Parameters<Plugin.Context["session"]["synthetic"]>[0]["sessionID"]

/**
 * The tools offered beside the runtime kernel by default: the memory tools. A
 * model with the kernel alone saved no note in the memory eval
 * (notes/memory-eval.md, round 2); offered directly, it saved most of them.
 */
export const DIRECT: ReadonlyArray<string> = ["memory_save", "memory_search", "memory_forget"]

/** A count of milliseconds or characters: finite and above zero. */
const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  idleMs: Positive.pipe(withDefault(30 * 60_000)),
  timeoutMs: Positive.pipe(withDefault(30_000)),
  viewChars: Positive.pipe(withDefault(8_000)),
  codeOnly: Schema.Boolean.pipe(withDefault(true)),
  denyExecute: Schema.Boolean.pipe(withDefault(true)),
  direct: Schema.Array(Schema.String).pipe(withDefault<ReadonlyArray<string>>(DIRECT)),
})
export type Options = typeof Options.Type

/** The contracts the model runs on, built once; a call's tools come with the call. */
export type Contracts = Workers | Snapshots | Sessions | Files

/** One implementation of each contract, as OpenCode and Bun provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Contracts> =>
  Layer.mergeAll(
    ProcessWorkers.layer({ timeoutMs: options.timeoutMs }),
    OpenCodeSnapshots.layer(ctx.storage),
    OpenCodeSessions.fromContext(ctx),
    FileStoreFiles.layer,
  )

/** A reply as the tool's content: its text, then each image as a file part with a data URI, named by its path. */
export const contentOf = (reply: Reply): ReadonlyArray<Tool.Content> => [
  { type: "text", text: reply.text },
  ...reply.images.map(
    (image): Tool.Content => ({
      type: "file",
      mime: image.mime,
      uri: `data:${image.mime};base64,${Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString("base64")}`,
      name: image.path,
    }),
  ),
]

/** The plugin on `externals`: OpenCode and Bun in production, memory and test Layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Contracts>) =>
  Plugin.define({
    id: "dotfiles-opencode.kernel",
    effect: Effect.fn("Kernel.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.kernel: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(
        Model.layer({ idleMs: options.idleMs, viewChars: options.viewChars }).pipe(Layer.provideMerge(externals(ctx, options))),
      )
      const kernel = Context.get(services, Model.Kernel)
      // Each session's runtime description, frozen at its first request (../../mods/kernel/frozen.ts).
      const catalogs = yield* Frozen.make((tools) => description(options, tools), description(options, []), ctx.storage)

      yield* ctx.tool.transform((editor) => {
        // The session's own subagents, listed, waited on and stopped: a cell's subagent handle calls it.
        editor.add(OpenCodeSubagents.tool(ctx))
        editor.add({
          name: "kernel",
          description: description(options),
          input: KernelInput,
          options: options.codeOnly ? { codemode: false, runtime: { describe: catalogs.describe, direct: options.direct } } : { codemode: false },
          execute: (input, context) => {
            // The tools the cell calls, live in the call's metadata and kept in its result's, so the
            // transcript draws what the cell did (../../mods/kernel/operations.ts). The journal closes
            // before the call settles: the host refuses progress after that.
            const journal = Operations.journal((metadata) => context.progress(metadata))
            return kernel
              .run({ session: KernelSessionId.make(context.sessionID), agent: context.agent, code: input.code, reset: input.reset === true })
              .pipe(
                Effect.provide(OpenCodeToolbox.forCall(ctx, context, journal)),
                Effect.ensuring(journal.close),
                Effect.mapError((unreadable) => new Tool.Error({ message: unreadable.message, error: unreadable })),
                Effect.flatMap((reply) =>
                  reply.ok
                    ? Effect.succeed({ content: contentOf(reply), metadata: journal.metadata() })
                    : Effect.fail(new Tool.Error({ message: reply.text })),
                ),
              )
          },
        })
      })

      if (!options.codeOnly && options.denyExecute)
        yield* ctx.agent.transform((editor) => {
          for (const agent of editor.list())
            editor.update(agent.id, (item) => {
              item.permissions.push({ action: "execute", resource: "*", effect: "deny" })
            })
        })

      if (options.codeOnly) {
        const scope = yield* Scope.Scope
        // A change in the tools is told once, in a message the session reads at its next step; the
        // description stays. The message waits for the session's next wake rather than waking it.
        const announce = (sessionID: SessionID, change: Frozen.Change) =>
          ctx.session
            .synthetic({
              sessionID,
              text: Frozen.notice(change),
              description: "Kernel tools changed",
              metadata: { kernelTools: { added: change.added.map((tool) => tool.name), removed: [...change.removed] } },
              delivery: "steer",
              resume: false,
            })
            .pipe(
              Effect.asVoid,
              Effect.catchCause((cause) => Effect.logWarning("kernel: could not announce a tool change", { sessionID, cause })),
            )
        // Every request of a session offers its frozen description in place of the live one, and
        // the direct tools its first request offered: a direct tool that joined since is dropped.
        const freeze = (event: { readonly sessionID: SessionID; readonly tools: Record<string, { description: string }> }) =>
          Effect.suspend(() => {
            const offered = event.tools.kernel
            if (offered === undefined) return Effect.void
            const direct = options.direct.filter((name) => Object.hasOwn(event.tools, name))
            return catalogs.offer(event.sessionID, offered.description, direct).pipe(
              Effect.flatMap((offer) => {
                offered.description = offer.description
                for (const name of direct) if (!offer.direct?.includes(name)) delete event.tools[name]
                return offer.change === undefined ? Effect.void : Effect.asVoid(Effect.forkIn(announce(event.sessionID, offer.change), scope))
              }),
            )
          })
        yield* ctx.session.hook("context", freeze)
        yield* ctx.session.hook("compaction", freeze)
        yield* ctx.session.hook("generate", freeze)
      }

      // A deleted session's worker stops and its stored bindings go, and its frozen description.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
          Stream.runForEach((event) =>
            Effect.all([catalogs.forget(event.data.sessionID), kernel.deleted(KernelSessionId.make(event.data.sessionID))], { discard: true }).pipe(
              Effect.ignoreCause,
            ),
          ),
          Effect.ignoreCause,
        ),
      )
    }),
  })

export default make(live)
