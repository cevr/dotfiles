import { Plugin } from "@opencode/plugin/effect"
import * as Configs from "@dotfiles/opencode-update/filestore/configs"
import * as Log from "@dotfiles/opencode-update/filestore/log"
import * as Records from "@dotfiles/opencode-update/filestore/records"
import * as Source from "@dotfiles/opencode-update/git/source"
import { GATE_POLL, Updater, updaterLayer } from "@dotfiles/opencode-update/model"
import * as Sessions from "@dotfiles/opencode-update/opencode/sessions"
import * as Builder from "@dotfiles/opencode-update/process/builder"
import * as Handoff from "@dotfiles/opencode-update/process/handoff"
import { UPDATE } from "@dotfiles/opencode-update/rpc"
import { every, files, Options, stepEnv } from "@dotfiles/opencode-update/settings"
import { Config, Context, Effect, Layer, Schedule, Schema } from "effect"

/** A directory as the host keys a location by it: without a trailing separator. */
export const canonical = (directory: string): string => directory.replace(/(.)\/+$/, "$1")

/** Every implementation the updater runs on, for these options and step variables. */
export const live = (ctx: Plugin.Context, options: Options, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.mergeAll(
    Source.layer({ root: options.checkout, mode: options.mode, bun: options.bun, fork: options.fork, env }),
    Builder.layer(options, env),
    Sessions.layer(ctx),
    Handoff.layer(options, env),
    Records.layer(options.record),
    Configs.layer({ config: options.config, kept: files(options).kept }),
    Log.layer(files(options).log, options.host),
  )

/**
 * The host's OpenCode updates itself. OpenCode runs a copy of the plugin per location; only the
 * resident location's copy (daily's `residentDir`, which every service start loads) updates, so a
 * host runs one updater. It looks for the verified target at start and every `everyMinutes`, and
 * when `bun run daily --update` asks (`check`).
 */
export default Plugin.define({
  id: "dotfiles-opencode.update",
  effect: Effect.fn("Update.plugin")(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
      Effect.catch((error) => Effect.die(new Error(`dotfiles-opencode.update: invalid options: ${error.message}`))),
    )
    if (canonical(ctx.location.directory) !== canonical(options.resident)) return
    const path = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => ""))
    const services = yield* Layer.build(updaterLayer({ fetchEvery: every(options) }).pipe(Layer.provide(live(ctx, options, stepEnv(options, path)))))
    const updater = Context.get(services, Updater)
    const scope = yield* Effect.scope
    yield* ctx.rpc.register(UPDATE, { check: () => Effect.forkIn(updater.check("asked"), scope).pipe(Effect.as({ started: true })) }).pipe(Effect.orDie)
    yield* Effect.forkScoped(updater.check("interval").pipe(Effect.delay(GATE_POLL), Effect.repeat(Schedule.spaced(every(options)))))
  }),
})
