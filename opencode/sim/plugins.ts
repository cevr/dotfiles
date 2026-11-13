// Our server plugins as the world loads them: each one's real composition
// root. Where a plugin reaches outside OpenCode (a process, an OS job), its
// externals are the world's: a monitor's checks run in the world's shell, on
// its clock; jobs are the plugin's own memory double and the OS backstop is
// off, as in the real scenarios. Everything that goes through OpenCode
// (storage, the session inbox, sessions, RPC) uses the plugin's own
// `opencode/` adapters on the world's plugin context.
import * as SourcesLive from "@dotfiles/opencode-anthropic-auth/registry/credential-sources"
import { make as makeAuth, makeShared } from "@dotfiles/opencode-cmd-anthropic-auth/server"
import IdleCompact from "@dotfiles/opencode-cmd-idle-compact/server"
import Questions from "@dotfiles/opencode-cmd-questions/server"
import { LIVE_STORE_HOST, type StoreHost, liveWith, make as makePool } from "@dotfiles/opencode-cmd-pool/server"
import * as MemoryPeers from "@dotfiles/opencode-pool/memory/peers"
import type * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import { type CredentialSource, storeProcess } from "@dotfiles/opencode-pool/store/store"
import * as Provider from "./provider.ts"
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

/** The questions plugin as OpenCode loads it: `cmd/questions/server.ts`'s default export, wholly on the plugin context. */
export const questions = Questions

/**
 * The pool (`cmd/pool/server.ts`'s `make`) on the world: OpenCode's adapters on its context, as the plugin
 * OpenCode loads; the fleet's peers are the world's (`peers`, each a report or a refusal), not SSH.
 */
export const pool = (peers: ReadonlyMap<string, MemoryPeers.Answer> = new Map(), stores: StoreHost = LIVE_STORE_HOST) =>
  makePool(
    liveWith(() => MemoryPeers.layer(peers)),
    stores,
  )

/**
 * The login stores of one simulated process: their files (shared by every process on the host), this process's
 * state of them, the world's network, and the registry this process's auth plugin reads.
 */
export interface Stores extends StoreHost {
  /** The registry this process's auth plugin reads. */
  readonly registry: SourcesLive.RegistryRead
}

/** One process's stores over `slots`, fetching from the world's `provider`. */
export const stores = (slots: MemorySlots.MemorySlots, provider: Provider.Provider): Stores => {
  const registry = new Map<string, Set<CredentialSource>>()
  return {
    source: { files: slots.files, process: storeProcess(), fetch: (url, init) => provider.fetch(url, init) },
    register: (integrationID, source) => {
      const sources = registry.get(integrationID) ?? new Set()
      registry.set(integrationID, sources.add(source))
      return () => void sources.delete(source)
    },
    registry: () => registry,
  }
}

/**
 * The Anthropic auth plugin (`cmd/anthropic-auth/server.ts`'s `make`) on the world: its fetch is the world's
 * provider, `ANTHROPIC_BASE_URL` the provider's origin, and its process-wide state its own; it reads the credential
 * sources at `registry` (a world's `stores(...).registry`, or the process's).
 */
export const anthropicAuth = (provider: Provider.Provider, registry: SourcesLive.RegistryRead = SourcesLive.processRegistry) =>
  makeAuth({
    fetch: provider.fetch,
    env: () => ({ baseUrl: Provider.ORIGIN, insecure: void 0, versionOverride: void 0 }),
    shared: makeShared(),
    registry,
  })
