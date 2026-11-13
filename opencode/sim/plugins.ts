// Our server plugins as the world loads them: each one's real composition
// root. Where a plugin reaches outside OpenCode (a process, an OS job), its
// externals are the world's: a monitor's checks and the status script run in
// the world's shell, on its clock; jobs are the plugin's own memory double and
// the OS backstop is off, as in the real scenarios. Everything that goes
// through OpenCode (storage, the session inbox, sessions, RPC) uses the
// plugin's own `opencode/` adapters on the world's plugin context. A TUI that
// reports to a server plugin is a client of the world (`draftClient`).
import * as SourcesLive from "@dotfiles/opencode-anthropic-auth/registry/credential-sources"
import { make as makeAuth, makeShared } from "@dotfiles/opencode-cmd-anthropic-auth/server"
import IdleCompact from "@dotfiles/opencode-cmd-idle-compact/server"
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
import { unitsIn } from "@dotfiles/opencode-orchestrate/filestore/step-log"
import { HEARTBEAT_MS, IDLE, type Reported, reportsOf, type Seen } from "@dotfiles/opencode-orchestrate/idle"
import type { Pace } from "@dotfiles/opencode-orchestrate/pace"
import { Branches, Findings, type FindingsRead, StepLog, UnitLogs } from "@dotfiles/opencode-orchestrate/service"
import { hosted, make as makeOrchestrate } from "@dotfiles/opencode-cmd-orchestrate/server"
import { make as makeQueue } from "@dotfiles/opencode-cmd-queue/server"
import * as MemoryQueue from "@dotfiles/opencode-queue/memory/store"
import { make as makeStatus } from "@dotfiles/opencode-cmd-status/server"
import * as StatusCallLog from "@dotfiles/opencode-status/memory/call-log"
import { RunTables, RunsUnreadable } from "@dotfiles/opencode-status/service"
import { Data, Effect, Layer, Option, Schema } from "effect"
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

/** What the orchestrate plugin keeps outside OpenCode, held in memory for a test to set and read. */
export interface OrchestrateDoubles {
  /** The call log's lines, as the plugin writes them. */
  readonly lines?: Array<CallLine>
  /** The Codex admission's answer for a model and role; none fails open, as the script with no admission line does. */
  readonly codex?: (model: string, role: string) => Option.Option<Pace>
}

/** The findings reader's answers. */
const Reads = Data.taggedEnum<FindingsRead>()

/** A call log line as the file holds it: JSON. */
const LineJson = Schema.fromJsonString(Schema.Unknown)

/**
 * The steps each session started, read back from the call log's `lines` as the file's step log reads the file
 * (`filestore/step-log.ts` `unitsIn`, over each line as JSON): one log, written by the plugin's CallLog, read by its
 * StepLog, as on disk.
 */
export const stepLogOf = (lines: ReadonlyArray<unknown>) =>
  Layer.succeed(StepLog, StepLog.of({ units: (sessionID) => Effect.sync(() => unitsIn(lines.map((line) => Schema.encodeSync(LineJson)(line)).join("\n"), sessionID)) }))

/**
 * The orchestrate plugin (`cmd/orchestrate/server.ts`'s `make`) on the world: everything that goes through OpenCode
 * (sessions, models, steering, the pool's, the wakes', the status's, the questions' and the queue's RPC) on its own
 * adapters over the world's context (`hosted`), as the plugin OpenCode loads; what it keeps in files or asks of
 * processes (the call log and the step log it reads back, the ledger, the Codex admission script, git, the unit logs'
 * script, the skill's files) its memory doubles, as `cmd/orchestrate/server.test.ts` holds them. The call log is one
 * for the plugin's life, its restarts too, as its file is.
 */
export const orchestrate = (doubles: OrchestrateDoubles = {}) => {
  const lines = doubles.lines ?? []
  return makeOrchestrate((ctx, options, start, background) =>
    Layer.mergeAll(
      hosted(ctx, start, background),
      MemoryLedger.layer(options.cadence, []),
      // No report reads, no Rift has a branch, no unit's log.md is found: the world keeps no files and runs no git or log.ts.
      Layer.succeed(Findings, Findings.of({ read: (report) => Effect.succeed(Reads.Unread({ why: `the report ${report} does not read` })) })),
      Layer.succeed(Branches, Branches.of({ of: () => Effect.succeed(void 0) })),
      Layer.succeed(UnitLogs, UnitLogs.of({ find: () => Effect.succeed(void 0), append: () => Effect.void, drops: () => Effect.succeed([]) })),
      CallLogTest.layer(lines),
      CodexAdmissionTest.layer((model, role) => Option.getOrUndefined((doubles.codex ?? (() => Option.none()))(model, role))),
      stepLogOf(lines),
      SkillTest.skill({ history: [] }),
      SkillTest.records({ seen: new Map() }),
      FleetTest.layer([]),
    ),
  )
}

/** A command in the world's shell, from a plugin's fiber: what it prints, after the time it runs. */
const shellOf = (world: World, command: string) =>
  Effect.suspend(() => {
    const process = world.processes(command, world.now())
    world.record("process", { command, exitCode: process.exitCode })
    return Effect.sleep(process.ms).pipe(Effect.as(process))
  })

/** How long the status script may run for one run, as the process adapter's timeout (`process/run-tables.ts`). */
export const STATUS_TIMEOUT_MS = 20_000

/**
 * The runs of a repository through the orchestrate skill's status script, in the world's shell, as the process
 * adapter (`@dotfiles/opencode-status/process/run-tables`) reads them on disk: the run folders `ls -1
 * <directory>/tmp/orchestrate` lists (none when it fails: no runs, or no repository), then each one's table as `bun
 * <script> <run dir>` prints it; a script that fails or runs past its timeout makes the runs unreadable. The world has
 * no git, so a directory is its repository's top. Both adapters keep the RunTables laws (mods/status/laws.ts).
 */
export const runTables = (world: World, script: string) =>
  Layer.succeed(RunTables, RunTables.of({
    list: (directory: string) =>
      Effect.gen(function* () {
        const root = `${directory}/tmp/orchestrate`
        const listed = yield* shellOf(world, `ls -1 ${root}`)
        if (listed.exitCode !== 0) return []
        const names = listed.stdout
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => name !== "")
        return yield* Effect.forEach(names, (name) =>
          Effect.gen(function* () {
            const dir = `${root}/${name}`
            const printed = yield* shellOf(world, `bun ${script} ${dir}`)
            if (printed.ms > STATUS_TIMEOUT_MS) return yield* new RunsUnreadable({ message: `${script} timed out after ${STATUS_TIMEOUT_MS} ms` })
            if (printed.exitCode !== 0) return yield* new RunsUnreadable({ message: `${script} failed: ${printed.stdout.trim() || `exit ${printed.exitCode}`}` })
            return { name, dir, table: printed.stdout }
          }),
        )
      }),
  }))

/**
 * The status plugin (`cmd/status/server.ts`'s `make`) on the world: its runs through the status script in the world's
 * shell (`runTables`); its call log, which only the /pool pane reads, an empty memory log.
 */
export const status = (world: World) => makeStatus((options) => Layer.merge(StatusCallLog.layer({ events: [] }), runTables(world, options.statusScript)))

/** The queue plugin (`cmd/queue/server.ts`'s `make`) on the world: its store the memory one (`memory`), which keeps the store's laws. */
export const queue = (memory: MemoryQueue.MemoryQueues = MemoryQueue.empty()) => makeQueue(() => MemoryQueue.layer(memory))

/**
 * The orchestrate TUI's draft reports (`cmd/orchestrate/tui.ts` `report`) as one client of the world: what it sees (the
 * root on screen, and whether its composer holds text) is set by `show`, as a key the composer took, and reported at
 * once as `reportsOf` says; a heartbeat on the world's clock looks again every `HEARTBEAT_MS`. Each report is the
 * client's call of `IDLE.draft`, a failure dropped, as the TUI drops it.
 */
export const draftClient = (world: World, client = "tui-1") => {
  const state = { last: Option.none<Reported>(), seen: Option.none<Seen>() }
  /** The reports due now, each one marked sent; none before the TUI shows a session. */
  const due = () => {
    const at = world.now()
    const drafts = Option.match(state.seen, { onNone: () => [], onSome: (seen) => reportsOf(Option.getOrUndefined(state.last), seen, at) })
    for (const draft of drafts) state.last = Option.filter(Option.some({ sessionID: draft.sessionID, at }), () => draft.drafting)
    return drafts.map((draft) => ({ ...draft, client }))
  }
  world.runtime.fork(
    Effect.forever(
      Effect.sleep(HEARTBEAT_MS).pipe(
        Effect.andThen(Effect.suspend(() => Effect.forEach(due(), (draft) => world.clientRpc(IDLE.id, "draft", draft).pipe(Effect.ignore), { discard: true }))),
      ),
    ),
  )
  return {
    /** The TUI shows the root `sessionID` with `composer` in its composer, as after a key. */
    show: (sessionID: string, composer: string) =>
      Effect.suspend(() => {
        state.seen = Option.some({ sessionID, drafting: composer.trim() !== "" })
        return Effect.forEach(due(), (draft) => world.rpc(IDLE.id, "draft", draft).pipe(Effect.ignore), { discard: true })
      }),
  }
}

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
