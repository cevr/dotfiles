// Our server plugins as the world loads them: each one's real composition
// root. Where a plugin reaches outside OpenCode (a process, an OS job), its
// externals are the world's: a monitor's checks run in the world's shell, on
// its clock; jobs are the plugin's own memory double and the OS backstop is
// off, as in the real scenarios. Everything that goes through OpenCode
// (storage, the session inbox, sessions, RPC) uses the plugin's own
// `opencode/` adapters on the world's plugin context.
import IdleCompact from "@dotfiles/opencode-cmd-idle-compact/server"
import { backstopOf, make as makeWake } from "@dotfiles/opencode-cmd-wake/server"
import * as MemoryRunner from "@dotfiles/opencode-wake/memory/runner"
import * as OpenCodeCourier from "@dotfiles/opencode-wake/opencode/courier"
import * as OpenCodeOpener from "@dotfiles/opencode-wake/opencode/opener"
import * as OpenCodeStore from "@dotfiles/opencode-wake/opencode/store"
import { Checks } from "@dotfiles/opencode-wake/service"
import { Effect, Layer } from "effect"
import type { World } from "./world.ts"

/** A check in the world's shell: the command's answer at this instant, after the time it runs (at most `timeoutMs`). */
const checksOf = (world: World) =>
  Layer.succeed(
    Checks,
    Checks.of({
      run: (command, _cwd, timeoutMs) =>
        Effect.gen(function* () {
          const process = world.processes(command, world.now())
          yield* Effect.sleep(Math.min(process.ms, timeoutMs))
          world.record("check", { command, exitCode: process.exitCode, stdout: process.stdout })
          if (process.ms > timeoutMs) return { exitCode: 124, stdout: "", stderr: "", timedOut: true }
          return { exitCode: process.exitCode, stdout: process.stdout, stderr: "", timedOut: false }
        }),
    }),
  )

/** The wakes plugin (`cmd/wake/server.ts`'s `make`) on the world: OpenCode's adapters on its context, its shell for checks. */
export const wake = (world: World) => {
  const runner = MemoryRunner.empty()
  return makeWake((ctx, options) =>
    Layer.mergeAll(
      OpenCodeStore.fromContext(ctx),
      OpenCodeCourier.fromContext(ctx),
      checksOf(world),
      OpenCodeOpener.fromContext(ctx),
      // No OS jobs from a simulation, whatever the options say.
      backstopOf({ ...options, backstop: "off" }),
      MemoryRunner.layer(runner),
    ),
  )
}

/** The idle compaction plugin as OpenCode loads it: `cmd/idle-compact/server.ts`'s default export, wholly on the plugin context. */
export const idleCompact = IdleCompact
