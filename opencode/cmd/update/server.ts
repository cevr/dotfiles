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
import * as ServiceProcess from "@dotfiles/opencode-update/process/service"
import { Heartbeat as HeartbeatService, Placer } from "@dotfiles/opencode-update/service"
import { UPDATE } from "@dotfiles/opencode-update/rpc"
import { every, files, Options, stepEnv } from "@dotfiles/opencode-update/settings"
import { type Status, status, watchdog } from "@dotfiles/opencode-update/watch"
import { Clock, Config, Context, Effect, Layer, Schema, type Scope } from "effect"

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

/** The step variables, by name. */
type Env = Readonly<globalThis.Record<string, string>>

/**
 * What the watchdog outside the resident location runs on. It reads the service over HTTP from its
 * registration (`registration`), never through `opencode api`.
 */
export const watchLayer = (options: Options, registration: string) =>
  Layer.mergeAll(Resident.layer(options.resident, registration), Heartbeat.layer(files(options).checked), Log.layer(files(options).log, options.host))

/** The systems the plugin runs on: the live ones in OpenCode, fakes in the seam tests (`server.test.ts`). */
export interface Externals {
  /** Where the service runs, and the move into its own scope. */
  readonly placement: () => Layer.Layer<Placer>
  /** What the updater runs on, in the resident location. */
  readonly live: (options: Options, env: Env) => Layer.Layer<Layer.Success<ReturnType<typeof live>>>
  /** What the watchdog runs on, outside it. */
  readonly watch: (options: Options) => Layer.Layer<Layer.Success<ReturnType<typeof watchLayer>>>
}

/** The live systems, in OpenCode's `ctx`; the service's registration is where XDG_STATE_HOME (or HOME) puts it. */
export const liveExternals = (ctx: Plugin.Context): Externals => ({
  placement: () => ProcessPlacement.layer(ProcessPlacement.optionsOf(process.pid, process.platform)),
  live: (options, env) => live(ctx, options, env),
  watch: (options) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const state = yield* Config.option(Config.String("XDG_STATE_HOME"))
        const home = yield* Config.withDefault(Config.String("HOME"), "")
        return watchLayer(options, ServiceProcess.registrationFile(state, home))
      }).pipe(Effect.orDie),
    ),
})

/** The update RPC's handlers, as the plugin registers them. */
export interface UpdateHandlers {
  readonly check: () => Effect.Effect<{ readonly started: boolean }>
  readonly placement: () => Effect.Effect<Placement>
  readonly status: () => Effect.Effect<Status>
}

/** What the plugin reads of its host: its options, its location, and the RPC registry. */
export interface Host {
  readonly options: Plugin.Context["options"]
  readonly location: { readonly directory: string }
  readonly rpc: {
    readonly register: (definition: typeof UPDATE, handlers: UpdateHandlers) => Effect.Effect<unknown, unknown, Scope.Scope>
  }
}

/**
 * One copy of the plugin, in `host`'s location, on `externals`. OpenCode runs a copy per location;
 * only the resident location's copy (daily's `residentDir`) updates, so a host runs one updater. It
 * looks for the verified target at start and every `everyMinutes`, and when `bun run daily
 * --update` asks (`check`). The launcher's `service start` loads the resident location; a service a
 * TUI started does not, so every other copy watches (`watch.ts`): it asks the service for the
 * resident location, and logs checks that stopped.
 */
export const plugin = Effect.fn("Update.plugin")(function* (host: Host, externals: Externals) {
  const options = yield* Schema.decodeUnknownEffect(Options)(host.options).pipe(
    Effect.catch((error) => Effect.die(new Error(`dotfiles-opencode.update: invalid options: ${error.message}`))),
  )
  // In every location: a service a TUI started loads its plugins in the TUI's location alone.
  const placer = Context.get(yield* Layer.build(externals.placement()), Placer)
  const placed = yield* placer.place
  const log = Placement.match(placed, { Placed: () => Effect.logDebug, Unplaced: () => Effect.logWarning, Unmanaged: () => Effect.logDebug })
  yield* log(`dotfiles-opencode.update: the service runs ${describePlacement(placed)}`)
  const since = yield* Clock.currentTimeMillis
  // Outside the resident location: the watchdog, which has the service load the resident location
  // (a service a TUI started never does by itself) and logs checks that stopped.
  if (canonical(host.location.directory) !== canonical(options.resident)) return yield* Layer.build(watchdog(every(options)).pipe(Layer.provide(externals.watch(options)))).pipe(Effect.asVoid)
  const path = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => ""))
  const services = yield* Layer.build(updaterLayer({ fetchEvery: every(options) }).pipe(Layer.provideMerge(externals.live(options, stepEnv(options, path)))))
  const updater = Context.get(services, Updater)
  const stamps = Context.get(services, HeartbeatService)
  const scope = yield* Effect.scope
  yield* host.rpc
    .register(UPDATE, {
      check: () => Effect.forkIn(updater.check("asked"), scope).pipe(Effect.as({ started: true })),
      placement: () => placer.observe,
      status: () => status(stamps.last, since, every(options)),
    })
    .pipe(Effect.orDie)
  yield* Effect.forkScoped(intervalChecks(updater.check, every(options)))
})

export default Plugin.define({
  id: "dotfiles-opencode.update",
  effect: (ctx) => plugin(ctx, liveExternals(ctx)),
})
