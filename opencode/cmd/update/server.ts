import { Plugin } from "@opencode/plugin/effect"
import * as Configs from "@dotfiles/opencode-update/filestore/configs"
import * as Heartbeat from "@dotfiles/opencode-update/filestore/heartbeat"
import * as Log from "@dotfiles/opencode-update/filestore/log"
import * as Records from "@dotfiles/opencode-update/filestore/records"
import * as Rejections from "@dotfiles/opencode-update/filestore/rejections"
import * as Source from "@dotfiles/opencode-update/git/source"
import { intervalChecks, Updater, updaterLayer } from "@dotfiles/opencode-update/model"
import * as Sessions from "@dotfiles/opencode-update/opencode/sessions"
import { describePlacement, Placement } from "@dotfiles/opencode-update/placement"
import * as Builder from "@dotfiles/opencode-update/process/builder"
import * as Handoff from "@dotfiles/opencode-update/process/handoff"
import * as HandoffMark from "@dotfiles/opencode-update/process/mark"
import * as ProcessPlacement from "@dotfiles/opencode-update/process/placement"
import * as Resident from "@dotfiles/opencode-update/process/resident"
import { Heartbeat as HeartbeatService, Placer } from "@dotfiles/opencode-update/service"
import { UPDATE } from "@dotfiles/opencode-update/rpc"
import { every, files, Options, stepEnv } from "@dotfiles/opencode-update/settings"
import { status, watchdog } from "@dotfiles/opencode-update/watch"
import { Clock, Config, Context, Effect, Layer, Schema } from "effect"

/** A directory as the host keys a location by it: without a trailing separator. */
export const canonical = (directory: string): string => directory.replace(/(.)\/+$/, "$1")

/** Every implementation the updater runs on, for these options and step variables. */
export const live = (ctx: Plugin.Context, options: Options, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.mergeAll(
    Source.layer({ root: options.checkout, mode: options.mode, bun: options.bun, fork: options.fork, env }),
    Builder.layer(options, env),
    Sessions.layer(ctx),
    Handoff.layer(options, env),
    HandoffMark.layer(files(options).mark, process.pid),
    Records.layer(options.record),
    Rejections.layer(files(options).rejected),
    Configs.layer({ config: options.config, kept: files(options).kept }),
    Log.layer(files(options).log, options.host),
    Heartbeat.layer(files(options).checked),
  )

/** What the watchdog outside the resident location runs on. */
export const watchLayer = (options: Options, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.mergeAll(Resident.layer(options, env), Heartbeat.layer(files(options).checked), Log.layer(files(options).log, options.host))

/**
 * The host's OpenCode updates itself. OpenCode runs a copy of the plugin per location; only the
 * resident location's copy (daily's `residentDir`) updates, so a host runs one updater. It looks
 * for the verified target at start and every `everyMinutes`, and when `bun run daily --update`
 * asks (`check`). The launcher's `service start` loads the resident location; a service a TUI
 * started does not, so every other copy watches (`watch.ts`): it asks the service for the resident
 * location, and logs checks that stopped.
 */
export default Plugin.define({
  id: "dotfiles-opencode.update",
  effect: Effect.fn("Update.plugin")(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
      Effect.catch((error) => Effect.die(new Error(`dotfiles-opencode.update: invalid options: ${error.message}`))),
    )
    // In every location: a service a TUI started loads its plugins in the TUI's location alone.
    const placer = Context.get(yield* Layer.build(ProcessPlacement.layer(ProcessPlacement.optionsOf(process.pid, process.platform))), Placer)
    const placed = yield* placer.place
    const log = Placement.match(placed, { Placed: () => Effect.logDebug, Unplaced: () => Effect.logWarning, Unmanaged: () => Effect.logDebug })
    yield* log(`dotfiles-opencode.update: the service runs ${describePlacement(placed)}`)
    const path = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => ""))
    const env = stepEnv(options, path)
    const since = yield* Clock.currentTimeMillis
    // Outside the resident location: the watchdog, which has the service load the resident location
    // (a service a TUI started never does by itself) and logs checks that stopped.
    if (canonical(ctx.location.directory) !== canonical(options.resident)) return yield* Layer.build(watchdog(every(options)).pipe(Layer.provide(watchLayer(options, env)))).pipe(Effect.asVoid)
    const services = yield* Layer.build(updaterLayer({ fetchEvery: every(options) }).pipe(Layer.provideMerge(live(ctx, options, env))))
    const updater = Context.get(services, Updater)
    const stamps = Context.get(services, HeartbeatService)
    const scope = yield* Effect.scope
    yield* ctx.rpc
      .register(UPDATE, {
        check: () => Effect.forkIn(updater.check("asked"), scope).pipe(Effect.as({ started: true })),
        placement: () => placer.observe,
        status: () => status(stamps.last, since, every(options)),
      })
      .pipe(Effect.orDie)
    yield* Effect.forkScoped(intervalChecks(updater.check, every(options)))
  }),
})
