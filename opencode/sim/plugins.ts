// Our server plugins as the world loads them: each one's real composition
// root. Where a plugin reaches outside OpenCode (a process, an OS job), its
// externals are the world's: a monitor's checks run in the world's shell, on
// its clock; jobs are the plugin's own memory double and the OS backstop is
// off, as in the real scenarios. Everything that goes through OpenCode
// (storage, the session inbox, sessions, RPC) uses the plugin's own
// `opencode/` adapters on the world's plugin context.
import * as SourcesLive from "@dotfiles/opencode-anthropic-auth/registry/credential-sources"
import { make as makeAuth, makeShared } from "@dotfiles/opencode-cmd-anthropic-auth/server"
import { make as makeGuard, sessionsOf } from "@dotfiles/opencode-cmd-guard/server"
import IdleCompact from "@dotfiles/opencode-cmd-idle-compact/server"
import type { ProcessInfo } from "@dotfiles/opencode-guard/kill"
import * as MemoryLaunchers from "@dotfiles/opencode-guard/memory/launchers"
import * as MemoryRepoRoots from "@dotfiles/opencode-guard/memory/repo-roots"
import { Processes, ProcessesUnreadable } from "@dotfiles/opencode-guard/service"
import { externalsOn as mailOn, make as makeMail } from "@dotfiles/opencode-cmd-mail/server"
import type * as MemoryNet from "@dotfiles/opencode-mail/memory/net"
import type * as MemoryPairs from "@dotfiles/opencode-mail/memory/pairs"
import * as MemoryTokens from "@dotfiles/opencode-mail/memory/tokens"
import Questions from "@dotfiles/opencode-cmd-questions/server"
import { LIVE_STORE_HOST, type StoreHost, liveWith, make as makePool } from "@dotfiles/opencode-cmd-pool/server"
import * as Lease from "@dotfiles/opencode-pool/lease"
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
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import * as CallLogTest from "@dotfiles/opencode-orchestrate/memory/call-log"
import * as CodexAdmissionTest from "@dotfiles/opencode-orchestrate/memory/codex-admission"
import * as FleetTest from "@dotfiles/opencode-orchestrate/memory/fleet"
import * as MemoryLedger from "@dotfiles/opencode-orchestrate/memory/ledger"
import * as SkillTest from "@dotfiles/opencode-orchestrate/memory/skill"
import * as StepLogTest from "@dotfiles/opencode-orchestrate/memory/step-log"
import type { Pace } from "@dotfiles/opencode-orchestrate/pace"
import { Branches, Findings, type FindingsRead, UnitLogs } from "@dotfiles/opencode-orchestrate/service"
import { hosted, make as makeOrchestrate } from "@dotfiles/opencode-cmd-orchestrate/server"
import { Data, Effect, Layer, Option } from "effect"
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

/**
 * The wakes plugin (`cmd/wake/server.ts`'s `make`) on the world: OpenCode's adapters on its context, its shell for
 * checks. Its jobs are `runner`'s, which the test drives as the job's command would (`MemoryRunner.running`, `ended`):
 * one runner across restarts, as a job outlives the server.
 */
export const wake = (world: World, runner: MemoryRunner.MemoryRunner = MemoryRunner.empty()) => {
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

/**
 * The machine the guard reads beside OpenCode: its process table, the repositories on disk, and the launchers it
 * writes, each with the fault a test may turn on at any instant: `ps` that fails, a launcher that cannot be written.
 */
export interface GuardMachine {
  processes: ReadonlyArray<ProcessInfo>
  psFails: boolean
  readonly repos: ReadonlyArray<string>
  /** Each launcher written, by its path (`/launchers/<n>/<name>`). */
  readonly launchers: Map<string, string>
  launchersFail: boolean
  /** Whether a systemd scope runs here: never on the world's machine unless a test says so. */
  readonly scope: boolean
}

export const guardMachine = (input: { readonly processes: ReadonlyArray<ProcessInfo>; readonly repos?: ReadonlyArray<string> }): GuardMachine => ({
  processes: input.processes,
  psFails: false,
  repos: input.repos ?? [],
  launchers: new Map(),
  launchersFail: false,
  scope: false,
})

/**
 * The guard (`cmd/guard/server.ts`'s `make`) on the world: where a session runs and whether it is a subagent through
 * its own OpenCode adapters on the world's context (`sessionsOf`); the process table, the repositories and the
 * launchers are the `machine`'s, under the guard's memory doubles' rules (`mods/guard/memory`, held by `mods/guard/laws.ts`).
 */
export const guard = (machine: GuardMachine) =>
  makeGuard((ctx) =>
    Layer.mergeAll(
      sessionsOf(ctx),
      MemoryRepoRoots.layer({ repos: machine.repos }),
      // The memory launchers read `unwritable` at each write: the machine's fault, as it is now.
      MemoryLaunchers.layer({
        written: machine.launchers,
        scope: machine.scope,
        get unwritable() {
          return machine.launchersFail
        },
      }),
      Layer.succeed(
        Processes,
        Processes.of({
          list: () =>
            Effect.suspend(() => {
              if (machine.psFails) return Effect.fail(new ProcessesUnreadable({ message: "ps exited 1" }))
              return Effect.succeed(machine.processes)
            }),
        }),
      ),
    ),
  )

/** What the orchestrate plugin keeps outside OpenCode, held in memory for a test to set and read. */
export interface OrchestrateDoubles {
  /** The call log's lines, as the plugin writes them. */
  readonly lines?: Array<CallLine>
  /** The Codex admission's answer for a model and role; none fails open, as the script with no admission line does. */
  readonly codex?: (model: string, role: string) => Option.Option<Pace>
}

/** The findings reader's answers. */
const Reads = Data.taggedEnum<FindingsRead>()

/**
 * The orchestrate plugin (`cmd/orchestrate/server.ts`'s `make`) on the world: everything that goes through OpenCode
 * (sessions, models, steering, the pool's, the wakes' and the others' RPC) on its own adapters over the world's context
 * (`hosted`), as the plugin OpenCode loads; what it keeps in files or asks of processes (the call log, the ledger, the
 * Codex admission script, git, the unit logs' script, the skill's files) its memory doubles, as
 * `cmd/orchestrate/server.test.ts` holds them.
 */
export const orchestrate = (doubles: OrchestrateDoubles = {}) =>
  makeOrchestrate((ctx, options, start, background) =>
    Layer.mergeAll(
      hosted(ctx, start, background),
      MemoryLedger.layer(options.cadence, []),
      // No report reads, no Rift has a branch, no unit's log.md is found: the world keeps no files and runs no git or log.ts.
      Layer.succeed(Findings, Findings.of({ read: (report) => Effect.succeed(Reads.Unread({ why: `the report ${report} does not read` })) })),
      Layer.succeed(Branches, Branches.of({ of: () => Effect.succeed(void 0) })),
      Layer.succeed(UnitLogs, UnitLogs.of({ find: () => Effect.succeed(void 0), append: () => Effect.void, drops: () => Effect.succeed([]) })),
      CallLogTest.layer(doubles.lines ?? []),
      CodexAdmissionTest.layer((model, role) => Option.getOrUndefined((doubles.codex ?? (() => Option.none()))(model, role))),
      StepLogTest.layer({}),
      SkillTest.skill({ history: [] }),
      SkillTest.records({ seen: new Map() }),
      FleetTest.layer([]),
    ),
  )

/** The idle compaction plugin as OpenCode loads it: `cmd/idle-compact/server.ts`'s default export, wholly on the plugin context. */
export const idleCompact = IdleCompact

/** The questions plugin as OpenCode loads it: `cmd/questions/server.ts`'s default export, wholly on the plugin context. */
export const questions = Questions

/**
 * The pool (`cmd/pool/server.ts`'s `make`) on the world: OpenCode's adapters on its context, as the plugin
 * OpenCode loads; the fleet's peers are the world's (`peers`, each a report or a refusal), not SSH. Its
 * leases are its own simulated process's, as `Lease.HOST` is a real process's: on the world's clock, never
 * the test runner's table.
 */
export const pool = (peers: ReadonlyMap<string, MemoryPeers.Answer> = new Map(), stores: StoreHost = LIVE_STORE_HOST) => {
  const leases = Layer.succeed(Lease.Leases, Lease.make())
  const externals = liveWith(() => MemoryPeers.layer(peers))
  return makePool((...args: Parameters<typeof externals>) => Layer.merge(externals(...args), leases), stores)
}

/**
 * The login stores of one simulated process: their files (shared by every process on the host), this process's
 * state of them, the world's network, and the registry this process's auth plugin reads.
 */
export interface Stores extends StoreHost {
  /** The registry this process's auth plugin reads. */
  readonly registry: SourcesLive.RegistryRead
}

/**
 * Session mail (`cmd/mail/server.ts`'s `make`) on the world: OpenCode's sessions through its context, the host's
 * pairing in memory (`pairs`, shared with its pair command), the hosts' memory network as `hostname` reaches it, and
 * tokens from the world's seeded random.
 */
export const mail = (network: MemoryNet.Network, pairs: MemoryPairs.MemoryPairs, hostname: string) =>
  makeMail((ctx) => mailOn(ctx, Layer.mergeAll(pairs.layer, network.layer(hostname), MemoryTokens.layer)))

/** A process with no login store whose network is the world's `provider` (the ChatGPT usage endpoint's too). */
export const network = (provider: Provider.Provider): StoreHost => ({
  source: { fetch: (url, init) => provider.fetch(url, init) },
  register: LIVE_STORE_HOST.register,
})

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
