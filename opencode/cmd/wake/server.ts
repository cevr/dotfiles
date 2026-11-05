/**
 * Wakes as an OpenCode server plugin. The composition root: it builds the
 * wakes model (`@dotfiles/opencode-wake/model`) on the plugin's storage, the
 * session inbox, owned `/bin/sh` checks and the Bun.cron backstop, registers
 * the `wake`, `monitor`, `wake_cancel` and `wake_list` tools, and answers the
 * wakes RPC (`WAKES`) the tray and the OS jobs call.
 *
 * - `wake` sets an alarm and `monitor` a polled command for the calling
 *   session, and return at once; a fire arrives as a synthetic steer that
 *   wakes the session (`notify`: waits for its next turn), or starts a fresh
 *   session (`newSession`). A subagent is refused. Direct tools, so a kernel
 *   cell reaches them as `tools.wake(...)`.
 * - Each entry also gets an OS job (`opencode-wake-<id>`) that fires it when
 *   no server runs: the job starts the OpenCode service and calls `due`.
 * - `pending({ sessionIDs })` for the tray, `due({ id })` for the OS jobs;
 *   every change publishes `changed({ sessionID })`.
 * - On start it arms this directory's entries (one past due fires now, and
 *   says how late) and drops OS jobs whose entry went; a deleted session's
 *   entries go; a notice goes once the session's turn takes it.
 *
 * Options: `backstop: "off"` keeps the OS jobs in memory (scenarios, tests);
 * `bun` and `opencode` name those programs by path.
 */
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect"
import * as CronBackstop from "@dotfiles/opencode-wake/cron/backstop"
import * as MemoryBackstop from "@dotfiles/opencode-wake/memory/backstop"
import { alarmReceipt, cancelReceipt, listing, monitorReceipt } from "@dotfiles/opencode-wake/message"
import * as Model from "@dotfiles/opencode-wake/model"
import * as OpenCodeCourier from "@dotfiles/opencode-wake/opencode/courier"
import * as OpenCodeStore from "@dotfiles/opencode-wake/opencode/store"
import * as ProcessChecks from "@dotfiles/opencode-wake/process/checks"
import { type Backstop, Changes, type Checks, type Courier, type WakeStore } from "@dotfiles/opencode-wake/service"
import {
  CANCEL_DESCRIPTION,
  CancelInput,
  LIST_DESCRIPTION,
  ListInput,
  MONITOR_DESCRIPTION,
  MonitorInput,
  NAMES,
  WAKE_DESCRIPTION,
  WakeInput,
} from "@dotfiles/opencode-wake/tools"
import { type Due, type Pending, WAKES, type WakeRejected } from "@dotfiles/opencode-wake/wake"

export const Options = Schema.Struct({
  /** `cron` (default): an OS job per entry through Bun.cron. `off`: jobs held in memory, for a server whose wakes must not outlive it. */
  backstop: Schema.optional(Schema.Literals(["cron", "off"])),
  /** A real bun, by path; default the one on PATH, else ~/.bun/bin/bun. */
  bun: Schema.optional(Schema.String),
  /** The launcher an OS job starts OpenCode with; default ~/.local/bin/opencode. */
  opencode: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

/** What the wakes run on. */
export type Externals = WakeStore | Courier | Checks | Backstop

/** The OS job's script, beside this file. */
export const SCRIPT = fileURLToPath(new URL("./backstop.ts", import.meta.url))

/** The OS backstop the options pick. */
export const backstopOf = (options: Options, env: Readonly<Record<string, string | undefined>> = process.env): Layer.Layer<Backstop> => {
  if (options.backstop === "off") return MemoryBackstop.layer(MemoryBackstop.empty())
  const home = env.HOME ?? homedir()
  return CronBackstop.layer({
    bun: options.bun ?? Bun.which("bun") ?? path.join(home, ".bun", "bin", "bun"),
    script: SCRIPT,
    jobs: path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode-wake", "jobs"),
    opencode: options.opencode ?? path.join(home, ".local", "bin", "opencode"),
    env,
    platform: process.platform,
    launchAgents: path.join(home, "Library", "LaunchAgents"),
    exec: CronBackstop.exec,
  })
}

/** The live externals: the plugin's storage, the session inbox, owned checks, and the backstop the options pick. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(OpenCodeStore.fromContext(ctx), OpenCodeCourier.fromContext(ctx), ProcessChecks.layer, backstopOf(options))

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })
const refused = (failure: WakeRejected) => new Tool.Error({ message: failure.reason, error: failure })

const PendingInput = Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })
const DueInput = Schema.Struct({ id: Schema.String })

/** The plugin on `externals`: OpenCode's in a server, the memory doubles in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: WAKES.id,
    effect: Effect.fn("Wake.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`${WAKES.id}: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // Changes are announced once the RPC is registered; one before then has no reader to tell.
      const announce = yield* Ref.make<(sessionID: string) => Effect.Effect<void>>(() => Effect.void)
      const changes = Layer.succeed(Changes, { changed: (sessionID) => Effect.flatMap(Ref.get(announce), (emit) => emit(sessionID)) })
      const services = yield* Layer.build(Model.layer({ directory: ctx.location.directory }).pipe(Layer.provide(Layer.merge(externals(ctx, options), changes))))
      const wakes = Context.get(services, Model.WakesModel)

      yield* ctx.tool.transform((editor) => {
        // Direct tools beside the others, so they are offered without code mode and reached from a kernel cell.
        editor.add({
          name: NAMES.wake,
          description: WAKE_DESCRIPTION,
          input: WakeInput,
          options: { codemode: false },
          execute: (input, context) =>
            wakes.wake(context.sessionID, input).pipe(
              Effect.map((placed) => text(alarmReceipt(placed.entry, placed.now, placed.warning))),
              Effect.mapError(refused),
            ),
        })
        editor.add({
          name: NAMES.monitor,
          description: MONITOR_DESCRIPTION,
          input: MonitorInput,
          options: { codemode: false },
          execute: (input, context) =>
            wakes.monitor(context.sessionID, input).pipe(
              Effect.map((placed) => text(monitorReceipt(placed.entry, placed.now, placed.warning))),
              Effect.mapError(refused),
            ),
        })
        editor.add({
          name: NAMES.cancel,
          description: CANCEL_DESCRIPTION,
          input: CancelInput,
          options: { codemode: false },
          execute: (input, context) => wakes.cancel(context.sessionID, input.id).pipe(Effect.map((gone) => text(cancelReceipt(gone))), Effect.mapError(refused)),
        })
        editor.add({
          name: NAMES.list,
          description: LIST_DESCRIPTION,
          input: ListInput,
          options: { codemode: false },
          execute: (_input, context) => wakes.list(context.sessionID).pipe(Effect.map((listed) => text(listing(listed.entries, listed.notices, listed.now)))),
        })
      })

      // A deleted session's wakes go; a notice goes once the session's turn took its message.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted", "session.inbox.delivered"] }).pipe(
          Stream.runForEach((event) =>
            (event.type === "session.deleted" ? wakes.forget(event.data.sessionID) : wakes.read(event.data.inboxID)).pipe(Effect.ignoreCause),
          ),
          Effect.ignoreCause,
        ),
      )

      const registration = yield* ctx.rpc
        .register(WAKES, {
          pending: (input) =>
            Schema.decodeUnknownEffect(PendingInput)(input).pipe(
              Effect.flatMap(({ sessionIDs }) => wakes.pending(sessionIDs)),
              Effect.orElseSucceed((): Pending => ({ now: Date.now(), entries: [], notices: [] })),
            ),
          due: (input) =>
            Schema.decodeUnknownEffect(DueInput)(input).pipe(
              Effect.flatMap(({ id }) => wakes.due(id)),
              Effect.orElseSucceed((): Due => ({ outcome: "pending" })),
            ),
        })
        .pipe(Effect.orDie)
      yield* Ref.set(announce, (sessionID) => registration.events.emit("changed", { sessionID }).pipe(Effect.ignore))

      // Arm what was set before this start, and fire what came due meanwhile, without holding up the start.
      yield* Effect.forkScoped(wakes.start.pipe(Effect.ignoreCause))
    }),
  })

export default make(live)
