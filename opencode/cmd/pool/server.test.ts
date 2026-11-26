// @reads all
// @reads-reason computed read at cmd/pool/server.test.ts: const written = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ line: Schema.Nul
// The plugin seam: the composition root on a stand-in host. On test layers it
// checks what OpenCode sees: the credential header, the retry decision, the
// ledger's keys, the sign-in marks and the pool's RPC answers. On the live
// adapters it checks how they reach the host's integration, quota RPC and
// storage. tests/pool-failover.test.ts and tests/pool-store-opencode.test.ts
// run it in OpenCode.
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Cause, Clock, Console, Effect, Exit, Fiber, FileSystem, Latch, Layer, Option, Order, Path, Queue, Schedule, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GateDecision } from "@dotfiles/opencode-pool/antigravity/gate"
import type * as AgyLive from "@dotfiles/opencode-pool/antigravity/live"
import type * as AgySource from "@dotfiles/opencode-pool/antigravity/source"
import { Answer as AgyAnswer } from "@dotfiles/opencode-pool/antigravity/state"
import { TestClock } from "effect/testing"
import { PoolId } from "@dotfiles/opencode-pool/account-pool"
import { CACHE_LIFE_MS, WINDOW_MS } from "@dotfiles/opencode-pool/accounts"
import * as FleetTest from "@dotfiles/opencode-pool/memory/fleet"
import { LEGACY_PREFIX } from "@dotfiles/opencode-pool/legacy-ids"
import * as LedgerTest from "@dotfiles/opencode-pool/memory/ledger"
import * as LedgerLive from "@dotfiles/opencode-pool/opencode/ledger"
import * as LimitsLive from "@dotfiles/opencode-pool/opencode/limits"
import type { LimitsAnswer } from "@dotfiles/opencode-pool/model"
import * as LoginsTest from "@dotfiles/opencode-pool/memory/logins"
import * as OwnerTest from "@dotfiles/opencode-pool/memory/owner"
import * as PeersTest from "@dotfiles/opencode-pool/memory/peers"
import * as QuotaTest from "@dotfiles/opencode-pool/memory/quota"
import * as ResetsTest from "@dotfiles/opencode-pool/memory/resets"
import type { Pace } from "@dotfiles/opencode-pool/pace"
import type { QuotaReading } from "@dotfiles/opencode-pool/quota"
import { type PublishedReading, Quota } from "@dotfiles/opencode-pool/service"
import { StoreSource } from "@dotfiles/opencode-pool/store/store"
import { type Alerts, type FleetStatus, POOL_STATUS, type PoolsStatus, type Report, type ResetsStatus, type SessionAnswer, type SessionLogins } from "@dotfiles/opencode-pool/status"
import { Handoff } from "@dotfiles/opencode-pool/handoff"
import * as HoldWake from "@dotfiles/opencode-pool/hold-wake"
import { HeldSendAnswer } from "@dotfiles/opencode-pool/refuse"
import { DEFAULT_HOLD_MS, MAX_REFUSAL } from "@dotfiles/opencode-pool/hold"
import { below, generator } from "../../sim/runtime.ts"
import { MIGRATED } from "@dotfiles/opencode-pool/opencode/migrate"
import { spentAccount, startFakeChatGPT } from "../../tests/fake-chatgpt.ts"
import { waitUntil } from "../../tests/wait.ts"
import Pool, { type AntigravityHost, type AntigravityRoot, CACHE_TTL_HEADER, CREDENTIAL_HEADER, LIVE_STORE_HOST, liveAntigravity, liveWith, make, NO_ANTIGRAVITY } from "./server.ts"
import * as PeersLive from "@dotfiles/opencode-pool/ssh/peers"
import { hangGuard, stamp } from "../../tests/hang-guard.ts"
import { sendCost } from "../../tests/pool-openai-send/cost.ts"

/** The live adapters of one process: each start is a process of its own, its shared storage read anew. */
const live = () => liveWith(PeersLive.layer)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const ANTHROPIC = PoolId.make("anthropic")

type Host = Parameters<(typeof Pool)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void>
type Handler = (input: unknown) => Effect.Effect<unknown>
/** A tool the plugin added: its name and how it runs, as the stand-in host keeps it. */
interface ToolDefinition {
  readonly name: string
  readonly execute: (input: { readonly action: string }, context: { readonly sessionID: string }) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }> }, unknown>
}

/** The provider's logins: two OAuth logins and an API key, which the pool leaves out. */
const CONNECTIONS = [
  { type: "credential", id: "cred-a", label: "Anthropic 1", method: "oauth" },
  { type: "credential", id: "cred-b", label: "Anthropic 2", method: "oauth" },
  { type: "credential", id: "cred-key", label: "Anthropic key", method: "key" },
]

const model = { providerID: "anthropic", id: "claude-haiku-4-5" }

interface SessionEvent {
  readonly type:
    | "session.step.started"
    | "session.step.ended"
    | "session.execution.succeeded"
    | "session.execution.failed"
    | "session.execution.interrupted"
  readonly data: {
    readonly sessionID: string
    readonly reason?: "user" | "shutdown" | "superseded" | "inactivity"
    readonly cost?: number
    readonly assistantMessageID?: string
    readonly model?: { readonly providerID: string; readonly id: string }
    readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  }
}

/** A session missing from the stand-in host, matching OpenCode's Session.NotFoundError shape. */
const SessionNotFound = Schema.TaggedStruct("Session.NotFoundError", { sessionID: Schema.String })
/** The stand-in host could not admit a notice (`World.wakeAccess.fails`). */
const SyntheticRefused = Schema.TaggedStruct("Session.SyntheticConflictError", { sessionID: Schema.String })

/** A limit tally of the test's own, in every start's options: the live adapters otherwise keep it under the owner's XDG_STATE_HOME. */
const scratchLimits = (root: string) => join(mkdtempSync(join(root, "pool-state-")), "limits.json")

/** A start's scratch directory, which holds its limit tallies; removed when the start's scope closes. */
const scratchRoot = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "pool-server-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/**
 * What the outside systems hold for one test. The test layers read it, and so
 * do the stand-in host's integration, quota RPC and storage the live adapters reach.
 */
interface World {
  /** The auth plugin's newest reading of each login. */
  readonly readings: Map<string, QuotaReading>
  /** The integration's connections (a pool absent there cannot be read) and the sign-in marks set on them. */
  readonly integration: LoginsTest.Integration
  /** The plugin's storage, by key. */
  readonly storage: Map<string, Schema.Json>
  readonly holdAccess: { scans: number; usage: number; unavailable: boolean; beforeRead: Effect.Effect<void> }
  /** Each agent's own prompt-cache lifetime (`request.settings.cacheTTL`), by agent id; an agent absent here is unknown to the host. */
  readonly agents: Map<string, string | undefined>
  /** Each fork's source, by fork id; a session absent here is no fork. */
  readonly forks: Map<string, string>
  /** The fleet's peers and what each answers, by name, in the config's order. */
  readonly peers: Map<string, PeersTest.Answer>
  /** Each login's credential as the host resolves it, by id. */
  readonly credentials: Map<string, unknown>
  /** The integration's active login, by integration. */
  readonly active: Map<string, string>
  /** The owner the pool asks about a Claude reset. */
  readonly owner: OwnerTest.MemoryOwner
  /** Each subagent session's parent, by id. */
  readonly parents: Map<string, string>
  /** Sessions missing from the host: `session.get` fails with `Session.NotFoundError`. */
  readonly missing: Set<string>
  /** Sessions stopped by their parent: `session.synthetic` admits the notice without waking them. */
  readonly stopped: Set<string>
  /** Synthetic messages delivered by the plugin, with whether the host woke the session on each. */
  readonly synthetics: Array<{ readonly sessionID: string; readonly id?: string; readonly text: string; readonly description?: string; readonly resume?: boolean; readonly woke: boolean }>
  /** Admitted synthetic ids (`${sessionID}\0${id}`), modelling the host's first-admission-wins reconciliation. */
  readonly admitted: Set<string>
  /**
   * The wake's host calls: `calls` every `session.synthetic` asked (a repeat the host refuses included), the next
   * `fails` of them fail before the host admits anything, `hang` holds a call after the host admitted it (the pool
   * never hears back), and `scans` counts the pool's reads of its held-send rows.
   */
  readonly wakeAccess: { calls: number; fails: number; hang: boolean; scans: number; down: boolean; lookups: boolean }
  /**
   * Where the plugin's held-send rows live: in `storage` by default, or in a file other processes write too
   * (`sqliteRows`). `down` fails the host's `session.get` and `session.synthetic` as a host that cannot answer does; `lookups` fails
   * `session.get` alone.
   */
  rows: HeldRows
}

/** The plugin's `held-send/` rows, wherever the stand-in host keeps them. */
interface HeldRows {
  readonly get: (key: string) => Option.Option<Schema.Json>
  readonly set: (key: string, value: Schema.Json) => void
  readonly remove: (key: string) => void
  readonly keys: (prefix: string) => ReadonlyArray<string>
}
const HELD_PREFIX = "held-send/"
const mapRows = (storage: Map<string, Schema.Json>): HeldRows => ({
  get: (key) => Option.fromUndefinedOr(storage.get(key)),
  set: (key, value) => void storage.set(key, value),
  remove: (key) => void storage.delete(key),
  keys: (prefix) => [...storage.keys()].filter((key) => key.startsWith(prefix)),
})
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
/** Rows in a SQLite file, as OpenCode's KV keeps a plugin's storage: every process that opens the file shares them. */
const sqliteRows = (file: string): HeldRows & { readonly close: () => void } => {
  const db = new Database(file, { create: true })
  db.run("create table if not exists kv (key text primary key, value text not null)")
  const one = db.query<{ value: string }, [string]>("select value from kv where key = ?")
  return {
    get: (key) => Option.map(Option.fromNullishOr(one.get(key)), ({ value }) => decodeJson(value)),
    set: (key, value) => void db.run("insert or replace into kv (key, value) values (?, ?)", [key, encodeJson(value)]),
    remove: (key) => void db.run("delete from kv where key = ?", [key]),
    keys: (prefix) => db.query<{ key: string }, [string]>("select key from kv where substr(key, 1, length(?1)) = ?1 order by key").all(prefix).map(({ key }) => key),
    close: () => db.close(),
  }
}

/** A host that cannot answer: `session.get` and `session.synthetic` fail, as neither would on a missing session. */
const HostDown = Schema.TaggedStruct("HostDown", { sessionID: Schema.String })

const world = (): World => {
  const storage = new Map<string, Schema.Json>()
  return {
    readings: new Map(),
    integration: { connections: new Map([[ANTHROPIC, CONNECTIONS]]), marks: [] },
    storage,
    holdAccess: { scans: 0, usage: 0, unavailable: false, beforeRead: Effect.void },
    agents: new Map([["build", undefined]]),
    forks: new Map(),
    peers: new Map(),
    credentials: new Map(),
    active: new Map(),
    owner: OwnerTest.empty(),
    parents: new Map(),
    missing: new Set(),
    stopped: new Set(),
    synthetics: [],
    admitted: new Set(),
    wakeAccess: { calls: 0, fails: 0, hang: false, scans: 0, down: false, lookups: false },
    rows: mapRows(storage),
  }
}

/** The outside systems as test layers over `state`. */
/** A reading as the ledger keeps it, as far as a test reads it: its windows' use. */
const decodeStored = Schema.decodeUnknownOption(Schema.Struct({ windows: Schema.Array(Schema.Struct({ utilization: Schema.Number })) }))

/** Fresh, quiet account windows: what the fake reads for a login with no custom quota. */
const quiet = (now: number) => ({
  at: now,
  windows: [
    { name: "5h", utilization: 0, resetAt: now - now % (5 * HOUR) + 5 * HOUR },
    { name: "7d", utilization: 0.01, resetAt: now + 72 * HOUR },
  ],
})

/** The memory quota, its usage read of a login with no reading answered by `quiet`. */
const quietUsage = Layer.effect(
  Quota,
  Effect.gen(function* () {
    const base = yield* Quota
    return Quota.of({
      ...base,
      usage: (pool, credentialID) =>
        base.usage(pool, credentialID).pipe(Effect.flatMap((reading) => Option.match(Option.fromUndefinedOr(reading), { onNone: () => Effect.map(Clock.currentTimeMillis, quiet), onSome: Effect.succeed }))),
    })
  }),
)

const testLayers = (state: World, published: Queue.Dequeue<PublishedReading>, root: string) => () =>
  Layer.mergeAll(
    LoginsTest.layer(state.integration),
    quietUsage.pipe(Layer.provide(QuotaTest.layer(new Map([[ANTHROPIC, state.readings]]), new Map([[ANTHROPIC, published]])))),
    LedgerTest.layer(state.storage),
    PeersTest.layer(state.peers),
    FleetTest.layer(state.storage),
    ResetsTest.layer(state.storage),
    OwnerTest.layer(state.owner),
    LimitsLive.layer(LedgerTest.storage(state.storage), join(mkdtempSync(join(root, "pool-limits-")), "limits.json")),
  )

/** A hook or RPC handler the plugin registered; a missing one fails the test. */
const registered = <F>(table: Readonly<Record<string, F>>, name: string) =>
  Effect.suspend(() => {
    const found = table[name]
    return found === undefined ? Effect.die(new Error(`not registered: ${name}`)) : Effect.succeed(found)
  })

/**
 * The plugin started on a stand-in host: its hooks, transforms and RPC, with
 * the host's integration, quota RPC and storage over `state`. `externals`
 * picks the adapters: the test layers by default, `live` for the real ones.
 */
const start = <R = never,>(
  options: Record<string, unknown> = { sweepMinutes: 0 },
  state: World = world(),
  externals: Parameters<typeof make>[0] | "test" = "test",
  /** Whether the start waits until the pool answers, its ledger read; else it ends once the plugin is active. */
  ready = true,
  /** The Antigravity root: none by default; one that needs the host's services makes the start need them too. */
  antigravity: AntigravityRoot<R> = NO_ANTIGRAVITY,
  /** The lock over the held-send rows: one per process (a reload's copies share it); a fresh one is another process. */
  sendRecords = LedgerLive.holdAuthority().lock,
) =>
  Effect.gen(function* () {
    const root = yield* scratchRoot
    const hooks: Record<string, Hook> = {}
    const rpc: Record<string, Record<string, Handler>> = {}
    const transforms: Array<(editor: unknown) => void> = []
    const tools = new Map<string, ToolDefinition>()
    const quotaIDs: Array<string> = []
    const statuses: Array<{ readonly credentialID: unknown; readonly status: unknown }> = []
    const events = yield* Queue.unbounded<SessionEvent>()
    const published = yield* Queue.unbounded<PublishedReading>()
    const answer = ({ credentialID }: { readonly credentialID: string }) =>
      Effect.sync(() => ({ reading: state.readings.get(credentialID) ?? null }))
    // A usage read of a login the test gave no reading: a fresh, quiet week (`quiet`).
    const usage = ({ credentialID }: { readonly credentialID: string }) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        state.holdAccess.usage += 1
        return { reading: state.readings.get(credentialID) ?? quiet(now) }
      })
    // The auth plugin's claim: recorded, never sent anywhere; a reset empties the account's 5-hour window.
    const claims: Array<{ readonly credentialID: string; readonly creditID: string; readonly requestID: string }> = []
    const claimOf = (input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string }) =>
      Effect.sync(() => {
        claims.push(input)
        const held = state.readings.get(input.credentialID)
        if (held !== undefined)
          state.readings.set(input.credentialID, {
            ...held,
            at: held.at + 1,
            windows: held.windows.map((window) => (window.name === "5h" ? { ...window, utilization: 0 } : window)),
          })
        return { outcome: "reset" }
      })
    // The questions plugin's RPC over the world's owner: a question asked as the pool, read back and withdrawn.
    const questionsRpc = {
      askFor: (input: { readonly key: string; readonly plugin: string } & Record<string, unknown>) =>
        Effect.sync(() => {
          const question = input as unknown as OwnerTest.MemoryOwner["asked"][number]
          if (!state.owner.questions.has(input.key)) {
            state.owner.questions.set(input.key, { question })
            state.owner.asked.push(question)
          }
          return { ok: true }
        }),
      asked: () =>
        Effect.sync(() => ({
          questions: [...state.owner.questions].map(([key, held]) => ({
            sessionID: held.question.sessionID,
            id: key,
            key,
            ...(held.answer === undefined ? {} : { answer: held.answer }),
          })),
        })),
      withdrawFor: ({ key }: { readonly key: string }) =>
        Effect.sync(() => {
          state.owner.questions.delete(key)
          state.owner.withdrawn.push(key)
          return { ok: true }
        }),
      events: { subscribe: () => Stream.fromQueue(state.owner.beats) },
    }
    const hostOptions = { limitsFile: scratchLimits(root), ...options }
    const storage = LedgerTest.storage(state.storage)
    /** The held-send rows for a `held-send/` key, else the plugin's other storage. */
    const rowsOf = (key: string): HeldRows => {
      if (key.startsWith(HELD_PREFIX)) return state.rows
      return mapRows(state.storage)
    }
    const host = {
      options: hostOptions,
      session: {
        get: ({ sessionID }: { readonly sessionID: string }) => {
          if (state.wakeAccess.down || state.wakeAccess.lookups) return Effect.fail(HostDown.make({ sessionID }))
          if (state.missing.has(sessionID)) return Effect.fail(SessionNotFound.make({ sessionID }))
          const source = state.forks.get(sessionID)
          const parentID = state.parents.get(sessionID)
          return Effect.succeed({
            id: sessionID,
            ...(source === undefined ? {} : { fork: { sessionID: source, boundary: {} } }),
            ...(parentID === undefined ? {} : { parentID }),
          })
        },
        synthetic: (input: { readonly sessionID: string; readonly id?: string; readonly text: string; readonly description?: string; readonly resume?: boolean }) =>
          Effect.suspend((): Effect.Effect<void, unknown> => {
            state.wakeAccess.calls += 1
            if (state.wakeAccess.down) return Effect.fail(HostDown.make({ sessionID: input.sessionID }))
            if (state.missing.has(input.sessionID)) return Effect.fail(SessionNotFound.make({ sessionID: input.sessionID }))
            if (state.wakeAccess.fails > 0) {
              state.wakeAccess.fails -= 1
              return Effect.fail(SyntheticRefused.make({ sessionID: input.sessionID }))
            }
            const key = Option.map(Option.fromUndefinedOr(input.id), (id) => `${input.sessionID}\0${id}`)
            if (Option.exists(key, (value) => state.admitted.has(value))) return Effect.void
            if (Option.isSome(key)) state.admitted.add(key.value)
            const woke = input.resume !== false && !state.stopped.has(input.sessionID)
            state.synthetics.push({ ...input, woke })
            if (state.wakeAccess.hang) return Effect.never
            return Effect.void
          }),
        hook: (name: string, callback: Hook) =>
          Effect.sync(() => {
            hooks[name] = callback
            return { dispose: Effect.void }
          }),
      },
      provider: {
        transform: (callback: (editor: unknown) => void) =>
          Effect.sync(() => {
            transforms.push(callback)
            return { dispose: Effect.void }
          }),
      },
      // As the host does, a subscription gets the event types it names.
      event: {
        subscribe: (input: { readonly types: ReadonlyArray<string> }) =>
          Stream.fromQueue(events).pipe(Stream.filter((event) => input.types.includes(event.type))),
      },
      tool: {
        transform: (callback: (editor: { readonly add: (tool: ToolDefinition) => void }) => void) =>
          Effect.sync(() => {
            callback({ add: (tool) => void tools.set(tool.name, tool) })
            return { dispose: Effect.void }
          }),
      },
      agent: {
        get: ({ agentID }: { readonly agentID: string }) => {
          if (!state.agents.has(agentID)) return Effect.fail(new Error(`Agent not found: ${agentID}`))
          const cacheTTL = state.agents.get(agentID)
          return Effect.succeed({ location: {}, data: { id: agentID, request: { settings: cacheTTL === undefined ? {} : { cacheTTL } } } })
        },
      },
      integration: {
        get: ({ integrationID }: { readonly integrationID: PoolId }) => {
          const connections = state.integration.connections.get(integrationID)
          return connections === undefined
            ? Effect.fail(new Error("no such integration"))
            : Effect.succeed({ location: {}, data: { id: integrationID, connections } })
        },
        connection: {
          status: ({ connection, status }: { readonly connection: { readonly id?: string }; readonly status: unknown }) =>
            Effect.sync(() => void statuses.push({ credentialID: connection.id, status })),
          resolve: (connection: { readonly id?: string }) => Effect.sync(() => state.credentials.get(connection.id ?? "")),
          active: (integrationID: string) =>
            Effect.sync(() => {
              const id = state.active.get(integrationID)
              return id === undefined ? undefined : { type: "credential", id, label: id, method: "oauth" }
            }),
        },
      },
      rpc: Object.assign(
        (definition: { readonly id: string }) => {
          if (definition.id === "dotfiles-opencode.questions") return questionsRpc
          quotaIDs.push(definition.id)
          return { reading: answer, usage, claim: claimOf, events: { subscribe: () => Stream.fromQueue(published) } }
        },
        {
          register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
            Effect.sync(() => {
              rpc[definition.id] = handlers
              return { dispose: Effect.void }
            }),
        },
      ),
      storage: {
        ...storage,
        get: (key: string) => Effect.sync(() => Option.getOrUndefined(rowsOf(key).get(key))),
        set: (key: string, value: Schema.Json) => {
          if (!key.startsWith(HELD_PREFIX)) return storage.set(key, value)
          return Effect.sync(() => state.rows.set(key, value))
        },
        remove: (key: string) => {
          if (!key.startsWith(HELD_PREFIX)) return storage.remove(key)
          return Effect.sync(() => state.rows.remove(key))
        },
        // As OpenCode's KV: written only over the value whose `rev` is `rev` (none counts as 0), or with none only if absent.
        setIf: (key: string, value: Schema.Json, rev?: number) => Effect.sync(() => {
          const rows = rowsOf(key)
          const stored = rows.get(key)
          const storedRev = Option.map(stored, (current) => Option.getOrElse(Schema.decodeUnknownOption(Schema.Struct({ rev: Schema.Number }))(current).pipe(Option.map(({ rev }) => rev)), () => 0))
          const fits = Option.match(Option.fromUndefinedOr(rev), { onNone: () => Option.isNone(stored), onSome: (expected) => Option.contains(storedRev, expected) })
          if (fits) rows.set(key, value)
          return fits
        }),
        scan: (input: Parameters<typeof storage.scan>[0]) => Effect.suspend(() => {
          if (input.prefix.startsWith("anthropic/hold/")) {
            state.holdAccess.scans += 1
            if (state.holdAccess.unavailable) return Effect.die("hold store unavailable")
            return state.holdAccess.beforeRead.pipe(Effect.andThen(storage.scan(input)))
          }
          if (!input.prefix.startsWith(HELD_PREFIX)) return storage.scan(input)
          state.wakeAccess.scans += 1
          return Effect.sync(() => {
            const limit = Option.getOrElse(Option.fromUndefinedOr(input.limit), () => LedgerLive.PAGE)
            const after = Option.fromUndefinedOr(input.after)
            const keys = state.rows.keys(input.prefix).filter((key) => Option.match(after, { onNone: () => true, onSome: (cursor) => key > cursor }))
            const page = keys.slice(0, limit)
            return {
              entries: page.flatMap((key) => Option.toArray(Option.map(state.rows.get(key), (value) => ({ key, value })))),
              ...Option.match(Option.filter(Arr.last(page), () => keys.length > limit), { onNone: () => ({}), onSome: (next) => ({ next }) }),
            }
          })
        }),
      },
    } as unknown as Host
    yield* make(externals === "test" ? testLayers(state, published, root) : externals, LIVE_STORE_HOST, sendRecords, antigravity).effect(host)
    // The model builds from the ledger after the plugin is active: a start is complete once the pool answers.
    if (ready) yield* Effect.exit(rpc[POOL_STATUS.id]!["alerts"]!({}))

    /** One model request of a session: the headers the pool sets on it. */
    const send = Effect.fn("PoolServerTest.send")(function* (sessionID = "ses_1", providerID = "anthropic", kind = "primary", agent = "build") {
      const headers: Record<string, string> = {}
      yield* (yield* registered(hooks, "model.request"))({ sessionID, agent, model: { ...model, providerID }, kind, headers })
      return headers
    })
    /** One model request of a session: the login the pool names on it. */
    const request = (...args: Parameters<typeof send>) => send(...args).pipe(Effect.map((headers) => headers[CREDENTIAL_HEADER]))
    const respond = Effect.fn("PoolServerTest.respond")(function* (status: number, sessionID = "ses_1") {
      yield* (yield* registered(hooks, "http.response"))({
        sessionID,
        agent: "build",
        model,
        kind: "primary",
        request: new Request("https://api.anthropic.com/v1/messages"),
        response: new Response(null, { status }),
      })
    })
    /** The host's retry decision after the pool saw the failed request. */
    const retry = Effect.fn("PoolServerTest.retry")(function* (decision: unknown = { retry: false }, sessionID = "ses_1", type = "api") {
      const event: Record<string, unknown> = { sessionID, agent: "build", model, error: { type }, attempt: 1, decision }
      yield* (yield* registered(hooks, "retry"))(event)
      return event.decision
    })
    /** The session's execution succeeded: it goes idle. */
    const idle = (sessionID: string) => emit({ type: "session.execution.succeeded", data: { sessionID } })
    const method = (name: string) => Effect.flatMap(registered(rpc, "dotfiles-opencode.pool"), (handlers) => registered(handlers, name))
    const handoff = Effect.fn("PoolServerTest.handoff")(function* (candidate: string, sessionID = "ses_1") {
      return yield* (yield* method("handoff"))({ candidate, sessionID, providerID: "anthropic", kind: "primary", model: model.id, agent: "build" })
    })
    const pace = Effect.fn("PoolServerTest.pace")(function* (providerID: string, sessionID?: string) {
      return (yield* (yield* method("pace"))({ providerID, ...(sessionID === undefined ? {} : { sessionID }) })) as Pace
    })
    const resets = Effect.gen(function* () {
      return (yield* (yield* method("resets"))({})) as ResetsStatus
    })
    const status = Effect.gen(function* () {
      return (yield* (yield* method("status"))({})) as PoolsStatus
    })
    const session = Effect.fn("PoolServerTest.session")(function* (query: unknown) {
      return (yield* (yield* method("session"))(query)) as SessionAnswer
    })
    /** A host event or a published reading, taken in before the test goes on. */
    const emit = (event: SessionEvent) => Queue.offer(events, event).pipe(Effect.andThen(settle))
    const publish = (reading: PublishedReading) => Queue.offer(published, reading).pipe(Effect.andThen(settle))
    const alerts = Effect.gen(function* () {
      return (yield* (yield* method("alerts"))({})) as Alerts
    })
    const logins = Effect.fn("PoolServerTest.logins")(function* (query: unknown) {
      return (yield* (yield* method("logins"))(query)) as SessionLogins
    })
    const started = Effect.fn("PoolServerTest.started")(function* (input: unknown) {
      return yield* (yield* method("started"))(input)
    })
    const report = Effect.gen(function* () {
      return (yield* (yield* method("report"))({})) as Report
    })
    const fleet = Effect.gen(function* () {
      return (yield* (yield* method("fleet"))({})) as FleetStatus
    })
    const limits = Effect.gen(function* () {
      return (yield* (yield* method("limits"))({})) as LimitsAnswer
    })
    /** A response of `providerID`'s model came back carrying `headers`. */
    const responded = Effect.fn("PoolServerTest.responded")(function* (providerID: string, headers: Record<string, string>, sessionID = "ses_1") {
      yield* (yield* registered(hooks, "http.response"))({
        sessionID,
        agent: "build",
        model: { ...model, providerID },
        kind: "primary",
        request: new Request("https://chatgpt.com/backend-api/codex/responses"),
        response: new Response(null, { status: 200, headers }),
      })
    })
    /** A frame of `providerID`'s websocket came in. */
    const received = Effect.fn("PoolServerTest.received")(function* (providerID: string, frame: string, sessionID = "ses_1") {
      yield* (yield* registered(hooks, "experimental.ws.receive"))({ sessionID, agent: "build", model: { ...model, providerID }, kind: "primary", frame })
    })
    return {
      /** The tally file the live adapters keep: the options' own, else this start's scratch one. */
      limitsFile: String(hostOptions.limitsFile),
      send,
      request,
      handoff,
      heldSend: (sessionID: string) => Effect.flatMap(method("heldSend"), (read) => read({ sessionID })),
      respond,
      retry,
      idle,
      pace,
      status,
      session,
      alerts,
      logins,
      started,
      report,
      fleet,
      limits,
      resets,
      claims,
      responded,
      received,
      emit,
      publish,
      transforms,
      quotaIDs,
      statuses,
      rpc,
      hooks,
      tools,
    }
  })

/** The keys the pool's ledger and stores wrote: the storage's, the migration's mark left out. */
/** The ledger's keys, each chunk's writer (a process's own random name) written `<writer>`. */
const ledgerKeys = (state: World) =>
  state.storage.keys().filter((key) => key !== MIGRATED).map((key) => key.replace(/^(chunk\/.*\/)[^/]+(\/\d{6})$/, "$1<writer>$2")).toArray()

/** Let the plugin's background fibers take in what was just offered: a real moment, on the test clock too. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 5)))

/** Waits, in real time, until `done` holds (tests/wait.ts); a wait that never ends fails naming `what`. */
const waitFor = (what: string, done: () => boolean) => Effect.promise(() => waitUntil(what, done))

type Scoped<A, E> = Effect.Effect<A, E, import("effect").Scope.Scope>
const scenario = <A, E>(body: Scoped<A, E>) => Effect.runPromise(Effect.scoped(body))
/** On the test clock, which starts at 0 and moves only when told. */
const onTestClock = <A, E>(body: Scoped<A, E>) =>
  scenario(
    Effect.gen(function* () {
      return yield* body
    }).pipe(Effect.provide(TestClock.layer())),
  )

test("the final handoff re-places a pending login that another copy has since held, with and without a reload", () =>
  onTestClock(Effect.gen(function* () {
    for (const reload of [false, true]) {
      const state = world()
      const options = { sweepMinutes: 0 }
      const first = yield* start(options, state)
      const writer = yield* start(options, state)
      expect(yield* first.request()).toBe("cred-a")
      expect(yield* writer.request("ses_writer")).toBe("cred-a")
      expect(yield* first.handoff("cred-a")).toEqual(Handoff.cases.Send.make({}))
      yield* writer.respond(429, "ses_writer")
      const current = yield* Option.match(Option.filter(Option.some(options), () => reload), {
        onNone: () => Effect.succeed(first), onSome: (config) => start(config, state),
      })
      expect(yield* current.handoff("cred-a")).toEqual(Handoff.cases.Prepare.make({ credentialID: "cred-b" }))
      expect(yield* current.handoff("cred-b")).toEqual(Handoff.cases.Send.make({}))
    }
  })))

test("the final handoff reads the hold store once, adds no usage read, and keeps its own storage retry", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    expect(yield* plugin.request()).toBe("cred-a")
    const { scans, usage } = state.holdAccess
    expect(yield* plugin.handoff("cred-a")).toEqual(Handoff.cases.Send.make({}))
    expect(state.holdAccess.scans - scans).toBe(1)
    expect(state.holdAccess.usage - usage).toBe(0)
    state.holdAccess.unavailable = true
    expect(yield* plugin.handoff("cred-a")).toMatchObject({
      message: "dotfiles-opencode.pool: the request is held: the pool could not confirm its current holds; retry the hold store read; it may go again at Dec 31, 1969, 7:00:01 PM EST",
    })
    state.holdAccess.unavailable = false
    expect(yield* plugin.handoff("cred-a")).toEqual(Handoff.cases.Send.make({}))
  })))

const refusalOf = <A, E>(request: Effect.Effect<A, E>) => Effect.map(Effect.exit(request), (exit) => {
  if (Exit.isSuccess(exit)) return ""
  return Cause.pretty(exit.cause)
})

test("R9 known rate limit with an unreadable end keeps its usual hold and the newer record", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    const now = 60_000
    const end = now + DEFAULT_HOLD_MS
    yield* TestClock.setTime(now)
    const raw = { kind: "rate-limit", at: now, untilMs: now + 2 * HOUR, until: "future-format" }
    state.storage.set("anthropic/hold/cred-a", raw)
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, reasonCode: "record-unreadable", retryAt: end })
    yield* TestClock.adjust(LedgerLive.UNREADABLE_HOLD_MS)
    expect(yield* refusalOf(plugin.request("ses_too_early"))).toContain("hold record is unreadable")
    expect(state.storage.get("anthropic/hold/cred-a")).toMatchObject({ raw })
    expect((yield* plugin.status).anthropic?.accounts[0]?.hold).not.toHaveProperty("raw")
    yield* TestClock.adjust(DEFAULT_HOLD_MS - LedgerLive.UNREADABLE_HOLD_MS - 1)
    expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, reasonCode: "record-unreadable", retryAt: end })
    yield* TestClock.adjust(1)
    state.readings.set("cred-a", { ...quiet(end), usage: { at: end, samples: 1 } })
    expect(yield* plugin.request()).toBe("cred-a")
    expect(state.storage.has("anthropic/hold/cred-a")).toBe(false)
  })))

test("R9-C every malformed or absurd end has one bounded, honest recheck", () =>
  onTestClock(Effect.gen(function* () {
    for (const [until, delay] of [[9e15, MAX_REFUSAL], [-1, LedgerLive.UNREADABLE_HOLD_MS],
      [Number.NaN, LedgerLive.UNREADABLE_HOLD_MS], ["Infinity", LedgerLive.UNREADABLE_HOLD_MS]] as const) {
      const state = world()
      state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      const now = 60_000
      const end = now + delay
      yield* TestClock.setTime(now)
      state.storage.set("anthropic/hold/cred-a", { kind: "future-kind", at: now, until })
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, reasonCode: "record-unreadable", retryAt: end })
      const reads = state.holdAccess.usage
      yield* TestClock.adjust(delay - 1)
      expect(yield* refusalOf(plugin.request("ses_before"))).toContain("hold record is unreadable")
      expect(state.holdAccess.usage).toBe(reads)
      yield* TestClock.adjust(1)
      state.readings.set("cred-a", { ...quiet(end), usage: { at: end, samples: 1 } })
      expect(yield* plugin.request("ses_at")).toBe("cred-a")
      expect(state.holdAccess.usage).toBe(reads + 1)
      yield* TestClock.setTime(now + 30 * 24 * HOUR)
      expect(state.storage.has("anthropic/hold/cred-a")).toBe(false)
    }
  })))

test("R9-A a future kind without a readable end permits one 429, not a second refused send", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    const raw = { kind: "overloaded", at: 0, untilMs: 2 * HOUR }
    state.storage.set("anthropic/hold/cred-a", raw)
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    expect(yield* refusalOf(plugin.request())).toContain("hold record is unreadable")
    expect(state.storage.get("anthropic/hold/cred-a")).toMatchObject({ raw })
    yield* TestClock.adjust(LedgerLive.UNREADABLE_HOLD_MS)
    const at = LedgerLive.UNREADABLE_HOLD_MS
    state.readings.set("cred-a", { ...quiet(at), usage: { at, samples: 1 } })
    expect(yield* plugin.request()).toBe("cred-a")
    expect(yield* plugin.handoff("cred-a")).toEqual(Handoff.cases.Send.make({}))
    yield* plugin.respond(429)
    expect(yield* refusalOf(plugin.request("ses_retry"))).toContain("all pool accounts are held")
    expect(state.storage.get("anthropic/hold/cred-a")).toMatchObject({ kind: "rate-limit", until: at + DEFAULT_HOLD_MS })
  })))

test("R9-A3 fresh usage replaces a damaged usage-limit with the actual spent window", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    const resetAt = 2 * HOUR
    state.storage.set("anthropic/hold/cred-a", { kind: "usage-limit", at: 0, untilMs: resetAt })
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    state.readings.set("cred-a", { ...quiet(0), usage: { at: 0, samples: 1 }, windows: [
      { name: "5h", utilization: 1, resetAt },
      { name: "7d", utilization: 0.5, resetAt: 72 * HOUR },
    ] })
    expect(yield* refusalOf(plugin.request())).toContain("all pool accounts are held")
    expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, retryAt: resetAt })
    expect(state.storage.get("anthropic/hold/cred-a")).toMatchObject({ kind: "usage-limit", until: resetAt })
  })))

test("an unreadable sign-in stays held until an authenticated usage sample", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    const key = "anthropic/hold/cred-a"
    const raw = { kind: "signin", at: 0, until: "future-format" }
    state.storage.set(key, raw)
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    yield* TestClock.adjust(30 * 24 * HOUR)
    expect(yield* refusalOf(plugin.request("ses_unauthenticated"))).toContain("hold record is unreadable")
    expect(state.storage.get(key)).toMatchObject({ raw })
    yield* TestClock.adjust(LedgerLive.UNREADABLE_HOLD_MS)
    const at = 30 * 24 * HOUR + LedgerLive.UNREADABLE_HOLD_MS
    state.readings.set("cred-a", { ...quiet(at), usage: { at, samples: 1 } })
    expect(yield* plugin.request("ses_authenticated")).toBe("cred-a")
    expect(state.storage.has(key)).toBe(false)
  })))

test("R10-6 two copies reserve just one usage read, then keep the later refusal and the raw record", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    const raw = { kind: "overloaded", at: 0, untilMs: 2 * HOUR }
    const key = "anthropic/hold/cred-a"
    state.storage.set(key, raw)
    const one = yield* start({ sweepMinutes: 0 }, state, live())
    const two = yield* start({ sweepMinutes: 0 }, state, live())
    const due = LedgerLive.UNREADABLE_HOLD_MS
    const end = due + 10 * MINUTE
    yield* TestClock.setTime(due)
    state.readings.set("cred-a", { ...quiet(due), usage: { at: due, samples: 1 }, refusal: { kind: "rate-limit", until: end } })
    const reads = state.holdAccess.usage
    const replies = yield* Effect.forEach([one, two, one, two, one], (copy, index) =>
      refusalOf(copy.request(`ses_wait_${index}`)), { concurrency: "unbounded" })
    expect(replies.every((reply) => reply.includes("hold record is unreadable"))).toBe(true)
    expect(state.holdAccess.usage - reads).toBe(1)
    expect(state.storage.get(key)).toMatchObject({ kind: "record-unreadable", until: end, raw })
    expect(yield* two.pace("anthropic")).toMatchObject({ ok: false, retryAt: end })
    const handoff = yield* two.handoff("cred-a")
    expect(Schema.is(Handoff.cases.Held)(handoff)).toBe(true)
    // The consumer gets no handoff/error string at all, only the typed fact.
    const fact = Schema.decodeUnknownSync(HeldSendAnswer)(yield* one.heldSend("ses_1"))
    expect(fact.hold).toMatchObject({ providerID: "anthropic", reasonCode: "record-unreadable", retryAt: end })
    yield* TestClock.setTime(end - 1)
    expect(yield* one.pace("anthropic")).toMatchObject({ ok: false, retryAt: end })
    expect(state.holdAccess.usage - reads).toBe(1)
    yield* TestClock.setTime(end)
    expect(state.storage.has("held-send/ses_1")).toBe(true)
    expect(yield* one.heldSend("ses_1")).toMatchObject({ state: "ended", hold: { retryAt: end } })
    state.readings.set("cred-a", { ...quiet(end), usage: { at: end, samples: 1 } })
    expect(yield* two.request("ses_reopened")).toBe("cred-a")
    expect(state.holdAccess.usage - reads).toBe(2)
    expect(state.storage.has(key)).toBe(false)
  })))

test("R9-B a malformed row stays local and keeps its first recheck across a restart", () =>
  onTestClock(Effect.gen(function* () {
    const decodeRow = Schema.decodeSync(Schema.fromJsonString(Schema.Json))
    for (const raw of ["null", '"{\\"kind\\":\\"usage-li"', '{"kind":"usage-limit"}'].map((value) => decodeRow(value))) {
      const state = world()
      const key = "anthropic/hold/cred-a"
      const now = 60_000
      yield* TestClock.setTime(now)
      state.storage.set(key, raw)
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      expect(yield* plugin.request("ses_load")).toBe("cred-b")
      const first = state.storage.get(key)
      expect(first).toMatchObject({ raw })
      yield* TestClock.adjust(30_000)
      const next = yield* start({ sweepMinutes: 0 }, state, live())
      yield* next.pace("anthropic")
      expect(state.storage.get(key)).toEqual(first)
      const at = now + LedgerLive.UNREADABLE_HOLD_MS
      yield* TestClock.setTime(at)
      state.readings.set("cred-a", { ...quiet(at), usage: { at, samples: 1 } })
      yield* next.request("ses_repaired")
      expect(state.storage.has(key)).toBe(false)
    }
  })))

test("R9-A2/D a usable end survives an unknown kind or a damaged observation time", () =>
  onTestClock(Effect.gen(function* () {
    for (const [kind, at] of [["future-kind", 0], ["usage-limit", "damaged"]] as const) {
      const state = world()
      state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      const until = 2 * HOUR
      yield* TestClock.setTime(0)
      state.storage.set("anthropic/hold/cred-a", { kind, at, until })
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      yield* TestClock.adjust(until - 1)
      expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, retryAt: until })
      expect(yield* refusalOf(plugin.request("ses_before"))).toContain("hold record is unreadable")
      yield* TestClock.adjust(1)
      state.readings.set("cred-a", { ...quiet(until), usage: { at: until, samples: 1 } })
      expect(yield* plugin.request("ses_at")).toBe("cred-a")
    }
  })))

test("a decoder that understands the original uses its refusal rather than the recovery deadline", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    const until = 2 * HOUR
    const raw = { kind: "rate-limit", at: 0, until }
    const stored = { kind: "record-unreadable", rawKind: raw.kind, at: 0, until: MINUTE, raw }
    const key = "anthropic/hold/cred-a"
    state.storage.set(key, stored)
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    yield* TestClock.adjust(MINUTE)
    expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, retryAt: until })
    expect(state.storage.get(key)).toEqual(stored)
  })))

test("R9-N a login that returns after a listing gap has not lost its unexpired hold", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    const key = "anthropic/hold/cred-a"
    const hold = { kind: "rate-limit", at: 0, until: HOUR }
    state.storage.set(key, hold)
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    expect(yield* plugin.request("ses_before")).toBe("cred-b")
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[1]])
    yield* TestClock.adjust(MINUTE)
    expect(yield* plugin.request("ses_gap")).toBe("cred-b")
    expect(state.storage.get(key)).toEqual(hold)
    state.integration.connections.set(ANTHROPIC, CONNECTIONS)
    yield* TestClock.adjust(MINUTE)
    expect(yield* plugin.request("ses_after")).toBe("cred-b")
    expect(state.storage.get(key)).toEqual(hold)
  })))

test("an unknown hold kind only fences its own login until a fresh authenticated usage read repairs it", () =>
  onTestClock(Effect.gen(function* () {
    const state = world()
    yield* TestClock.setTime(60_000)
    state.storage.set("anthropic/hold/cred-a", { kind: "future-kind", at: 59_000, until: 61_000 })
    const plugin = yield* start({ sweepMinutes: 0 }, state, live())
    expect(yield* plugin.request()).toBe("cred-b")
    expect((yield* plugin.status).anthropic).toMatchObject({ accounts: [
      { credentialID: "cred-a", hold: { kind: "record-unreadable", rawKind: "future-kind", until: 61_000 } },
      { credentialID: "cred-b" },
    ] })
    expect(yield* plugin.handoff("cred-b")).toEqual(Handoff.cases.Send.make({}))
    yield* TestClock.adjust(999)
    expect(yield* plugin.request("ses_early")).toBe("cred-b")
    yield* TestClock.adjust(1)
    state.readings.set("cred-a", { ...quiet(61_000), usage: { at: 61_000, samples: 1 } })
    yield* plugin.request("ses_repair")
    expect(state.storage.has("anthropic/hold/cred-a")).toBe(false)
  })))

test("several pages of retired sign-ins are pruned against the current logins across generated session histories", () =>
  onTestClock(Effect.gen(function* () {
    const random = generator("retired-sign-in-histories")
    yield* TestClock.setTime(10)
    for (let turn = 0; turn < 3; turn++) {
      const state = world()
      const history = LedgerLive.PAGE + 1 + below(random, 200)
      for (let index = 0; index < history; index++) {
        const credentialID = `retired-${index}`
        state.storage.set(`anthropic/hold/${credentialID}`, { kind: "signin", until: 10, at: 0 })
        state.storage.set(`anthropic/cache/ses_past_${index}`, { credentialID, at: 0 })
      }
      state.storage.set("anthropic/hold/cred-a", { kind: "signin", until: 10, at: 0 })
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      expect(yield* plugin.request(`ses_current_${turn}`)).toBe("cred-b")
      const holds = [...state.storage.keys()].filter((key) => key.startsWith("anthropic/hold/"))
      expect(holds).toEqual(["anthropic/hold/cred-a"])
    }
  })))

describe("the options", () => {
  test("take their defaults when absent or undefined", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ providers: undefined, sweepMinutes: undefined, sources: undefined, cacheLifeMs: undefined })
        expect(yield* plugin.request()).toBe("cred-a")
        expect(plugin.transforms).toEqual([])
      }),
    ))

  test("a malformed option stops the plugin and says which", async () => {
    const malformed: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ providers: "anthropic" }, '["providers"]'],
      [{ providers: { anthropic: 7 } }, '["providers"]["anthropic"]'],
      [{ sweepMinutes: "10" }, '["sweepMinutes"]'],
      [{ sweepMinutes: Number.POSITIVE_INFINITY }, '["sweepMinutes"]'],
      [{ sources: [{ kind: "other", dir: "/x" }] }, '["sources"][0]["kind"]'],
      [{ sources: [{ kind: "store", dir: "" }] }, '["sources"][0]["dir"]'],
      [{ sources: [{ kind: "store", dir: "/x", tokenURL: 7 }] }, '["sources"][0]["tokenURL"]'],
      [{ cacheLifeMs: "1h" }, '["cacheLifeMs"]'],
      [{ cacheLifeMs: 0 }, '["cacheLifeMs"]'],
    ]
    for (const [options, path] of malformed) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start(options))))
      expect(exit._tag).toBe("Failure")
      const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined
      expect(reason?._tag).toBe("Die")
      const message = reason?._tag === "Die" && reason.defect instanceof Error ? reason.defect.message : ""
      expect(message).toStartWith("dotfiles-opencode.pool: invalid options: ")
      expect(message).toContain(`at ${path}`)
    }
  })

  test("the installed Anthropic and OpenAI bindings and an arbitrary alias leave the pool available", () =>
    scenario(Effect.gen(function* () {
      const installed = { providers: { anthropic: "anthropic" }, paced: { openai: "openai" }, sweepMinutes: 0 }
      const plugin = yield* start(installed)
      expect(yield* plugin.request()).toBe("cred-a")
      const alias = yield* start({ ...installed, paced: { ...installed.paced, sim: "anthropic" } })
      expect(yield* alias.pace("sim")).toMatchObject({ ok: true, tracking: "not-tracked-no-pool-login" })
      const reserve = yield* Effect.flatMap(registered(alias.rpc, "dotfiles-opencode.pool"), (handlers) => registered(handlers, "reserveLaunch"))
      expect(yield* reserve({ providerID: "sim", model: "fixture", sessionID: "parent", launchID: "alias-one" })).toMatchObject({ ok: true, measured: false, tracking: "not-tracked-no-pool-login" })
      const placedAlias = yield* start({ ...installed, providers: { ...installed.providers, sim: "anthropic" } })
      expect(yield* placedAlias.pace("sim")).toMatchObject({ ok: true, tracking: "not-tracked-no-pool-login" })
    })))
})

describe("the hooks", () => {
  test("one hold-store read per send attempt, no read for socket control frames", () =>
    scenario(Effect.gen(function* () {
      const state = world()
      state.active.set("anthropic", "cred-a")
      const plugin = yield* start({ paced: { sim: "anthropic" }, sweepMinutes: 0 }, state, live())
      const http = yield* registered(plugin.hooks, "http.request")
      const websocket = yield* registered(plugin.hooks, "experimental.ws.send")
      const cost = yield* sendCost((transport, { sessionID, stepID, tracked, frame }) => {
        const providerID = Option.getOrElse(Option.filter(Option.some("sim"), () => tracked), () => "other")
        const event = { sessionID, kind: "primary", model: { ...model, providerID }, step: { id: stepID } }
        if (transport === "http") return http(event)
        return websocket({ ...event, frame })
      })
      expect(cost.http.tracked.holdLockWaitMs.n).toBe(1_000)
      expect(cost.websocket.tracked.holdLockWaitMs.n).toBe(1_000)
      expect(cost.websocket.oneStream.holdLockWaitMs.n).toBe(1)
      expect(cost.websocket.eightSessions.holdLockWaitMs.n).toBe(1_000)
      expect(state.holdAccess.usage).toBe(0)
      yield* Console.log("send-cost simulated", Schema.encodeSync(Schema.fromJsonString(Schema.Json))(cost))
    })))

  test("a signed-out route sends without a hold, but retains a sign-in refusal for its last selected login", () =>
    scenario(Effect.gen(function* () {
      const state = world()
      state.active.set("anthropic", "cred-a")
      const options = { providers: { anthropic: "anthropic", alias: "anthropic" }, sweepMinutes: 0 }
      const plugin = yield* start(options, state, live())
      const send = yield* registered(plugin.hooks, "http.request")
      const event = { sessionID: "ses_signout", kind: "primary", model: { ...model, providerID: "alias" } }
      // No signed placement is possible for this alias; use the login the host chose.
      state.active.set("anthropic", "cred-b")
      expect(yield* plugin.request(event.sessionID, "alias")).toBeUndefined()
      yield* send(event)
      state.active.delete("anthropic")
      yield* send(event)
      expect(yield* plugin.heldSend(event.sessionID)).toEqual({})
      expect(yield* plugin.pace("alias")).toMatchObject({ ok: true, tracking: "not-tracked-no-pool-login" })
      expect(yield* plugin.status).toMatchObject({ anthropic: { untrackedRoutes: { alias: "not-tracked-no-pool-login" } } })
      const at = yield* Clock.currentTimeMillis
      state.storage.set("anthropic/hold/cred-b", { kind: "signin", at, until: at + MINUTE })
      expect(Exit.isFailure(yield* Effect.exit(send(event)))).toBe(true)
      expect(yield* plugin.heldSend(event.sessionID)).toMatchObject({ hold: { providerID: "alias", reasonCode: "account-held" } })
      expect(yield* plugin.pace("alias")).toMatchObject({ ok: false, measured: true, retryAt: at + MINUTE })
    })))

  test("a due sign-in recheck is reserved once for eight sends across two copies", () =>
    onTestClock(Effect.gen(function* () {
      const state = world()
      state.active.set("anthropic", "cred-a")
      const options = { paced: { sim: "anthropic" }, sweepMinutes: 0 }
      const authority = live()
      const one = yield* start(options, state, authority)
      const two = yield* start(options, state, authority)
      const key = "anthropic/hold/cred-a"
      state.storage.set(key, { kind: "signin", at: 0, until: MINUTE })
      const before = state.holdAccess.usage
      const send = (i: number) => Effect.gen(function* () {
        const copy = Option.getOrElse(Option.filter(Option.some(one), () => i % 2 === 0), () => two)
        const hook = yield* registered(copy.hooks, "experimental.ws.send")
        const frame = { sessionID: `ses_due_${i}`, kind: "primary", model: { ...model, providerID: "sim" },
          step: { id: `step_${i}` }, frame: '{"type":"response.create"}' }
        yield* hook(frame)
        return frame
      })
      const inputs = Array.from({ length: 8 }, (_, i) => i)
      const first = yield* Effect.forEach(inputs, send, { concurrency: 8 })
      expect(first.every((frame) => "refuse" in frame)).toBe(true)
      expect(state.holdAccess.usage).toBe(before)
      yield* TestClock.setTime(MINUTE)
      const due = yield* Effect.forEach(inputs, send, { concurrency: 8 })
      expect(due.every((frame) => "refuse" in frame)).toBe(true)
      expect(state.holdAccess.usage - before).toBe(1)
      expect(state.storage.get(key)).toMatchObject({ kind: "signin", until: MINUTE + LedgerLive.UNREADABLE_HOLD_MS })
    })))

  test("control frames are not gated; another response.create on the same Step is refused", () =>
    scenario(Effect.gen(function* () {
      const state = world()
      state.active.set("anthropic", "cred-a")
      const plugin = yield* start({ paced: { sim: "anthropic" }, sweepMinutes: 0 }, state, live())
      const send = yield* registered(plugin.hooks, "experimental.ws.send")
      const payload = { sessionID: "ses_frames", kind: "primary", model: { ...model, providerID: "sim" } }
      const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ type: Schema.String })))
      const frame = (id: string, type: string, attempt = 1) => ({ ...payload, step: { id, attempt }, frame: encode({ type }) })
      yield* send(frame("first", "response.create"))
      const at = yield* Clock.currentTimeMillis
      state.storage.set("anthropic/hold/cred-a", { kind: "rate-limit", at, until: at + MINUTE })
      const retry = frame("first", "response.create", 2)
      const control = frame("first", "response.cancel")
      const next = frame("next", "response.create")
      yield* send(control)
      yield* send(retry)
      expect(yield* plugin.heldSend(payload.sessionID)).toMatchObject({ hold: { stepID: "first" } })
      yield* send(next)
      expect(retry).toMatchObject({ refuse: { until: at + MINUTE } })
      expect(control).not.toHaveProperty("refuse")
      expect(next).toMatchObject({ refuse: { until: at + MINUTE } })
      expect(yield* plugin.heldSend(payload.sessionID)).toMatchObject({ hold: { stepID: "next" } })
    })))

  test("a paused retry leaves the previous refusal readable until its send is admitted", () =>
    onTestClock(Effect.gen(function* () {
      const state = world()
      state.active.set("anthropic", "cred-a")
      const plugin = yield* start({ paced: { sim: "anthropic" }, sweepMinutes: 0 }, state, live())
      const send = yield* registered(plugin.hooks, "http.request")
      const sessionID = "ses_paused"
      const key = "anthropic/hold/cred-a"
      const eventFor = (id: string) => ({ sessionID, kind: "primary", model: { ...model, providerID: "sim" }, step: { id } })
      const event = eventFor("first")
      state.storage.set(key, { kind: "rate-limit", at: 0, until: MINUTE })
      yield* send(event)
      expect(event).toHaveProperty("refuse")
      yield* TestClock.setTime(MINUTE)
      state.storage.delete(key)
      const reading = yield* Latch.make()
      const resume = yield* Latch.make()
      state.holdAccess.beforeRead = reading.open.pipe(Effect.andThen(resume.await))
      const retry = eventFor("next")
      const sending = yield* Effect.forkChild(send(retry))
      yield* reading.await
      expect(yield* plugin.heldSend(sessionID)).toMatchObject({ state: "ended", hold: { stepID: "first", retryAt: MINUTE } })
      yield* resume.open
      yield* Fiber.join(sending)
      expect(retry).not.toHaveProperty("refuse")
      expect(yield* plugin.heldSend(sessionID)).toEqual({})
    })))

  test("pool only the provider's OAuth logins and name the chosen one on the request", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        expect(yield* plugin.request("ses_2")).toBe("cred-b")
        expect(yield* plugin.request("ses_3")).not.toBe("cred-key")
      }),
    ))

  test("leave other providers alone", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("ses_1", "openai")).toBeUndefined()
      }),
    ))

  test("a plan-limit 429 holds the login, in the ledger too, and its run retries at once on the other", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        expect(yield* plugin.request()).toBe("cred-a")
        state.readings.set("cred-a", {
          at: stamp(),
          status: "rejected",
          windows: [{ name: "5h", utilization: 1, resetAt: stamp() + 2 * HOUR }],
          refusal: { kind: "usage-limit", until: stamp() + 2 * HOUR },
        })
        yield* plugin.respond(429)
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(true)
        expect(yield* plugin.retry()).toEqual({ retry: true, delay: 0 })
        expect(yield* plugin.request()).toBe("cred-b")
      }),
    ))

  test("a 429 without a reading still holds the login for the default time", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.request()
        yield* plugin.respond(429)
        expect(yield* plugin.retry()).toEqual({ retry: true, delay: 0 })
      }),
    ))

  test("an overloaded answer holds nothing and leaves the host's retry decision", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request()
        yield* plugin.respond(529)
        expect(yield* plugin.retry({ retry: true, delay: 2000 })).toEqual({ retry: true, delay: 2000 })
        expect(yield* plugin.request()).toBe("cred-a")
        // Only where the session's cache is, beside the readings its dispatch took: no hold.
        expect(ledgerKeys(state).filter((key) => !key.includes("/reading/"))).toEqual(["anthropic/cache/ses_1"])
      }),
    ))

  test("a sign-in refusal that never reached a response fails over, and marks the login as needing a sign-in once", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request()
        state.readings.set("cred-a", { at: stamp(), windows: [], refusal: { kind: "signin", until: stamp() + 30 * 60_000 } })
        expect(yield* plugin.retry()).toEqual({ retry: true, delay: 0 })
        expect(state.integration.marks).toEqual([{ pool: ANTHROPIC, credentialID: "cred-a", needed: true }])
        expect(yield* plugin.request()).toBe("cred-b")
        // A reading that no longer asks for a sign-in clears the mark, once.
        state.readings.set("cred-a", { at: stamp(), windows: [] })
        yield* plugin.pace("anthropic")
        yield* plugin.pace("anthropic")
        expect(state.integration.marks).toEqual([
          { pool: ANTHROPIC, credentialID: "cred-a", needed: true },
          { pool: ANTHROPIC, credentialID: "cred-a", needed: false },
        ])
      }),
    ))

  test("a sign-in refusal on a login the pool cannot name (placed before a restart, its mark pruned) goes again, placed afresh; a 429 stays the host's", () =>
    scenario(
      Effect.gen(function* () {
        // A new process: the session's request went out before it, and nothing names its login.
        const plugin = yield* start()
        expect(yield* plugin.retry({ retry: false }, "ses_before", "Authentication")).toEqual({ retry: true, delay: 0 })
        expect(yield* plugin.retry({ retry: false }, "ses_before", "RateLimit")).toEqual({ retry: false })
        expect(yield* plugin.retry({ retry: true, delay: 2000 }, "ses_before", "RateLimit")).toEqual({ retry: true, delay: 2000 })
      }),
    ))

  test("readings published by the auth plugin hold a login without any request", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* plugin.request("ses_0")
        yield* plugin.publish({
          credentialID: "cred-a",
          reading: { at: stamp(), windows: [], refusal: { kind: "rate-limit", until: stamp() + 60_000 } },
        })
        expect(yield* plugin.request("ses_new")).toBe("cred-b")
      }),
    ))

  test("a priced step counts on its session's login, and an idle session's run ends", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 3 } })
        // A step of a session the pool never placed counts nowhere.
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_other", cost: 5 } })
        const loads = (yield* plugin.status).anthropic?.accounts.map((account) => [account.credentialID, account.load, account.live])
        expect(loads).toEqual([
          ["cred-a", 3, 1],
          ["cred-b", 0, 0],
        ])
        expect(yield* plugin.request("ses_2")).toBe("cred-b")
        yield* plugin.idle("ses_1")
        yield* plugin.idle("ses_2")
        // Their caches still live on their logins.
        const live = (yield* plugin.status).anthropic?.accounts.map((account) => account.live)
        expect(live).toEqual([1, 1])
      }),
    ))

  test("a run ends however its execution ends, but for a shutdown, which the resumed execution goes on from", () =>
    scenario(
      Effect.gen(function* () {
        // A cache that lives 1 ms: `live` counts runs alone.
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: 1 })
        const sessions = ["ses_ok", "ses_failed", "ses_user", "ses_shutdown"]
        for (const sessionID of sessions) yield* plugin.request(sessionID)
        const live = Effect.map(plugin.status, (status) => status.anthropic?.accounts.reduce((total, account) => total + account.live, 0))
        expect(yield* live).toBe(4)
        yield* plugin.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_ok" } })
        yield* plugin.emit({ type: "session.execution.failed", data: { sessionID: "ses_failed" } })
        yield* plugin.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_user", reason: "user" } })
        yield* plugin.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_shutdown", reason: "shutdown" } })
        expect(yield* live).toBe(1)
      }),
    ))
})

describe("the limit tally", () => {
  const opus = { providerID: "anthropic", id: "claude-opus-5-5" }
  const million = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

  test("a step's tokens count on its login once, and a reading of the login's window rates them", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", model: opus } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        // Another copy of the plugin saw the same step: it counts once.
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", model: opus } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        yield* TestClock.adjust(MINUTE)
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: HOUR + MINUTE, windows: [{ name: "5h", utilization: 0.02, resetAt: 5 * HOUR }] } })
        const answer = yield* plugin.limits
        expect(answer.tally?.recent.map((w) => [w.pool, w.window, w.families.map((f) => [f.family, f.weighted.rate, f.n])])).toEqual([
          ["anthropic", "5h", [["Opus", 2, 1]]],
        ])
        expect(answer.line).toBe("limit/Mtok 5h: Opus 2.0% n 1 (last 7 days)")
        // What a peer reads of this host: its tokens on each open row, the 5-hour window's and the week its dispatch read.
        expect((yield* plugin.report).limits?.rows.map((row) => row.sums)).toEqual([{ Opus: { w: 1_000_000, raw: 1_000_000 } }, { Opus: { w: 1_000_000, raw: 1_000_000 } }])
      }),
    ))

  test("a step whose start the plugin never saw names no model: it counts in no tally", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start()
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: HOUR + MINUTE, windows: [{ name: "5h", utilization: 0.02, resetAt: 5 * HOUR }] } })
        expect((yield* plugin.limits).tally?.recent).toEqual([])
      }),
    ))
})

describe("a session's cache", () => {
  /** Two sessions, each on its own login, then idle: s1's login carries more load, so b scores better. */
  const loaded = (plugin: Effect.Success<ReturnType<typeof start>>) =>
    Effect.gen(function* () {
      expect(yield* plugin.request("s1")).toBe("cred-a")
      expect(yield* plugin.request("s2")).toBe("cred-b")
      yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
      yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 1 } })
      yield* plugin.idle("s1")
      yield* plugin.idle("s2")
    })

  test("keeps the session on its login for the cache life the options give, then load places it", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR })
        yield* loaded(plugin)
        yield* TestClock.adjust(HOUR / 2)
        expect(yield* plugin.request("s1")).toBe("cred-a")
        yield* plugin.idle("s1")
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("s1")).toBe("cred-b")
      }),
    ))

  test("a fork with no cache of its own goes to its source's login, against the load", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.forks.set("fork", "s1")
        const plugin = yield* start({ sweepMinutes: 0 }, state)
        yield* loaded(plugin)
        // b scores better, but the fork reads s1's cache, which is on a.
        expect(yield* plugin.request("fork")).toBe("cred-a")
        expect(yield* plugin.request("other")).toBe("cred-b")
      }),
    ))

  test("survives a restart: the new process keeps the session on its cache's login", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        yield* loaded(yield* start(undefined, state))
        yield* TestClock.adjust(CACHE_LIFE_MS - 1)
        const next = yield* start(undefined, state)
        expect(yield* next.request("s1")).toBe("cred-a")
      }),
    ))

  // OpenCode runs a copy of the plugin per location, all on one storage. The ledger, 2026-11-08 02:17: after a
  // restart two build sessions 50 minutes into their hour's cache moved to another login and wrote 115k and
  // 138k tokens again; another location's copy, whose view of them was its start's, had pruned their marks.
  test("survives a restart after another location's copy swept its older view of the session", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const here = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        yield* loaded(here)
        // Another location's copy starts and reads the marks as they are now.
        yield* start({ sweepMinutes: 10, cacheLifeMs: HOUR }, state)
        // s1 goes on here for 50 minutes.
        yield* TestClock.adjust(50 * MINUTE)
        expect(yield* here.request("s1")).toBe("cred-a")
        yield* here.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* here.idle("s1")
        // The other copy sweeps past the hour of its own view of s1.
        yield* TestClock.adjust(20 * MINUTE)
        const next = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect(yield* next.request("s1")).toBe("cred-a")
      }),
    ))

  /** The provider gives an hour; the implementor role keeps its own five minutes, as orchestrate sets it. */
  const roles = () => {
    const state = world()
    state.agents.set("implementor", "5m")
    return state
  }

  test("of a role that keeps its own 5-minute lifetime lets the session go after 5 minutes, though the provider's is an hour", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, roles())
        expect(yield* plugin.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        expect(yield* plugin.request("s2")).toBe("cred-b")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 1 } })
        yield* plugin.idle("s1")
        yield* plugin.idle("s2")
        // Inside its five minutes the role stays on its cache's login, against the load.
        yield* TestClock.adjust(CACHE_LIFE_MS - 1)
        expect(yield* plugin.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 0 } })
        yield* plugin.idle("s1")
        // Its step kept the role's lifetime: five minutes after it, load places the session.
        yield* TestClock.adjust(CACHE_LIFE_MS)
        expect((yield* plugin.status).anthropic?.accounts.map((account) => account.live)).toEqual([0, 1])
        expect(yield* plugin.request("s1", "anthropic", "primary", "implementor")).toBe("cred-b")
      }),
    ))

  test("of a main session keeps the provider's hour, and an agent the host cannot name keeps it too", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, roles())
        expect(yield* plugin.request("s1")).toBe("cred-a")
        expect(yield* plugin.request("s2", "anthropic", "primary", "ghost")).toBe("cred-b")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 1 } })
        yield* plugin.idle("s1")
        yield* plugin.idle("s2")
        yield* TestClock.adjust(HOUR - 1)
        expect((yield* plugin.status).anthropic?.accounts.map((account) => account.live)).toEqual([1, 1])
        expect(yield* plugin.request("s1")).toBe("cred-a")
        expect(yield* plugin.request("s2", "anthropic", "primary", "ghost")).toBe("cred-b")
      }),
    ))

  test("of a role survives a restart with its own lifetime: it holds the session five minutes, and its mark is kept the provider's hour", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = roles()
        const first = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect(yield* first.request("s1", "anthropic", "primary", "implementor")).toBe("cred-a")
        yield* first.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 5 } })
        yield* first.idle("s1")
        expect(state.storage.get("anthropic/cache/s1")).toEqual({ credentialID: "cred-a", at: 0, lifeMs: CACHE_LIFE_MS })
        yield* TestClock.adjust(CACHE_LIFE_MS)
        const second = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        // Kept, though it no longer holds the session: the status counts only another session live.
        expect(state.storage.has("anthropic/cache/s1")).toBe(true)
        yield* second.request("other")
        const live = (yield* second.status).anthropic?.accounts.map((account) => account.live) ?? []
        expect(live.reduce((total, count) => total + count, 0)).toBe(1)
        yield* TestClock.adjust(HOUR - CACHE_LIFE_MS)
        yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        expect(state.storage.has("anthropic/cache/s1")).toBe(false)
      }),
    ))

  test("of a role that comes back after its five minutes, within the hour, asks for the hour from that request on", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = roles()
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, state)
        const step = (cost: number) => plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost } })
        const role = () => plugin.send("s1", "anthropic", "primary", "implementor")
        expect((yield* role())[CACHE_TTL_HEADER]).toBeUndefined()
        yield* step(1)
        // Back inside its five minutes: the role's own lifetime pays off.
        yield* TestClock.adjust(CACHE_LIFE_MS - 1)
        expect((yield* role())[CACHE_TTL_HEADER]).toBeUndefined()
        yield* step(1)
        // Back after a ten-minute shell command: its cache had expired, so the prompt it writes again is
        // written for the hour ...
        yield* TestClock.adjust(10 * MINUTE)
        const raised = yield* role()
        expect(raised[CACHE_TTL_HEADER]).toBe("1h")
        yield* step(1)
        // ... and the one after reads it at that hour, which keeps the session on its login that long.
        yield* TestClock.adjust(MINUTE)
        const next = yield* role()
        expect(next[CACHE_TTL_HEADER]).toBe("1h")
        expect(next[CREDENTIAL_HEADER]).toBe(raised[CREDENTIAL_HEADER])
        yield* step(1)
        // The ledger keeps it, so a restart goes on asking for the hour.
        expect(state.storage.get("anthropic/cache/s1")).toMatchObject({ lifeMs: HOUR, outlived: true })
        yield* plugin.idle("s1")
        expect(yield* plugin.request("s2")).toBe("cred-b")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s2", cost: 0 } })
        yield* TestClock.adjust(30 * MINUTE)
        const later = yield* role()
        expect(later[CACHE_TTL_HEADER]).toBe("1h")
        expect(later[CREDENTIAL_HEADER]).toBe(raised[CREDENTIAL_HEADER])
        yield* step(1)
        // An hour without a request starts over at the role's own lifetime.
        yield* TestClock.adjust(HOUR)
        expect((yield* role())[CACHE_TTL_HEADER]).toBeUndefined()
      }),
    ))

  test("of a main session never names a lifetime: its agent keeps the provider's", () =>
    onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, cacheLifeMs: HOUR }, roles())
        expect((yield* plugin.send("s1"))[CACHE_TTL_HEADER]).toBeUndefined()
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* TestClock.adjust(10 * MINUTE)
        expect((yield* plugin.send("s1"))[CACHE_TTL_HEADER]).toBeUndefined()
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* TestClock.adjust(MINUTE)
        expect((yield* plugin.send("s1"))[CACHE_TTL_HEADER]).toBeUndefined()
      }),
    ))

  test("that died before a restart is dropped from the ledger, and load places the session", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        yield* loaded(yield* start(undefined, state))
        yield* TestClock.adjust(CACHE_LIFE_MS)
        const next = yield* start(undefined, state)
        expect([...state.storage.keys()].filter((key) => key.includes("/cache/"))).toEqual([])
        expect(yield* next.request("s1")).toBe("cred-b")
      }),
    ))
})

describe("the ledger", () => {
  // A week of steps takes the live storage tens of seconds to read, and the host serves no provider until every
  // plugin of the location is active: the plugin is active before its ledger is read.
  test("is read after the plugin is active: a request meanwhile waits for it and goes where it says", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.storage.set("anthropic/hold/cred-a", { kind: "usage-limit", until: 10 * HOUR, at: 0 })
        const open = yield* Latch.make(false)
        let scans = 0
        const storage = LedgerTest.storage(state.storage)
        const slow = LedgerLive.layer({ ...storage, scan: (options) => Effect.sync(() => void scans++).pipe(Effect.andThen(open.await), Effect.andThen(storage.scan(options))) })
        const root = yield* scratchRoot
        const published = yield* Queue.unbounded<PublishedReading>()
        const plugin = yield* start({ sweepMinutes: 0 }, state, () => Layer.merge(testLayers(state, published, root)(), slow), false)
        expect(Object.keys(plugin.hooks).sort()).toEqual(["experimental.model.resolve", "experimental.ws.send", "http.request", "http.response", "model.request", "retry"])
        yield* waitFor("the ledger read", () => scans > 0)
        const request = yield* Effect.forkChild(plugin.request("s1"))
        yield* settle
        expect(request.pollUnsafe()).toBeUndefined()
        yield* open.open
        expect(yield* Fiber.join(request)).toBe("cred-b")
      }),
    ))

  test("keeps holds, readings, priced steps and caches under the pool's id, and a new process reads them back", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust(HOUR)
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request("s1")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 0.25 } })
        yield* plugin.publish({ credentialID: "cred-b", reading: { at: HOUR, windows: [], refusal: { kind: "usage-limit", until: 3 * HOUR } } })
        expect(ledgerKeys(state).sort()).toEqual([
          "anthropic/cache/s1",
          "anthropic/hold/cred-b",
          // The week s1's dispatch read on the login it went out on.
          "anthropic/reading/cred-a",
          "anthropic/reading/cred-b",
          "chunk/step/anthropic/<writer>/000000",
        ])

        const next = yield* start(undefined, state)
        expect(yield* next.request("s2")).toBe("cred-a")
        const accounts = (yield* next.status).anthropic?.accounts
        expect(accounts?.map((account) => [account.credentialID, account.load, account.hold?.kind])).toEqual([
          ["cred-a", 0.25, undefined],
          ["cred-b", 0, "usage-limit"],
        ])
      }),
    ))

  test("a new process drops steps out of the window and past holds, and leaves what does not decode out", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request("s1")
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 1 } })
        yield* plugin.publish({ credentialID: "cred-a", reading: { at: 0, windows: [], refusal: { kind: "rate-limit", until: 1000 } } })
        state.storage.set("anthropic/reading/cred-b", "not a reading")
        state.storage.set("other/hold/cred-a", { kind: "usage-limit", until: WINDOW_MS * 2, at: 0 })
        yield* TestClock.adjust(WINDOW_MS)

        const next = yield* start(undefined, state)
        // The first process's chunk stays: that process may still append to it for a day after its first step
        // (chunks.ts SEAL_MS). Its step is past the window, so nothing counts it.
        expect(ledgerKeys(state).sort()).toEqual([
          "anthropic/reading/cred-a",
          "anthropic/reading/cred-b",
          "chunk/step/anthropic/<writer>/000000",
          "other/hold/cred-a",
        ])
        yield* next.pace("anthropic")
        const accounts = (yield* next.status).anthropic?.accounts
        expect(accounts?.map((account) => [account.credentialID, account.load, account.hold, account.reading?.at])).toEqual([
          ["cred-a", 0, undefined, 0],
          ["cred-b", 0, undefined, undefined],
        ])
      }),
    ))
})

describe("the sweep", () => {
  test("a steady sweep prunes the ledger and retires absent logins in the same hold scan", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        yield* start({ sweepMinutes: 1 }, state, live())
        yield* TestClock.adjust("1 second")
        const before = { ...state.holdAccess }
        state.storage.set("anthropic/hold/retired", { kind: "signin", at: 0, until: MINUTE })
        yield* TestClock.adjust("1 minute")
        expect(state.holdAccess.usage - before.usage).toBe(2)
        expect(state.holdAccess.scans - before.scans).toBe(3) // two readings and one prune
        expect(state.storage.has("anthropic/hold/retired")).toBe(false)
      }),
    ))

  test("reads every login's usage a moment after start, then every few minutes", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.readings.set("cred-a", { at: 0, windows: [], refusal: { kind: "usage-limit", until: 2 * HOUR } })
        const plugin = yield* start({ sweepMinutes: 5 }, state)
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(false)
        yield* TestClock.adjust("1 second")
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(true)
        expect(yield* plugin.request()).toBe("cred-b")
        state.readings.set("cred-b", { at: 1000, windows: [{ name: "7d", utilization: 0.5, resetAt: 3 * HOUR }] })
        // The dispatch read cred-b's quiet week at once; the sweep reads its newer one only at its next turn.
        const halfUsed = () => Option.exists(decodeStored(state.storage.get("anthropic/reading/cred-b")), (stored) => stored.windows.some((window) => window.utilization === 0.5))
        yield* TestClock.adjust("4 minutes")
        expect(halfUsed()).toBe(false)
        yield* TestClock.adjust("1 minute")
        expect(halfUsed()).toBe(true)
      }),
    ))

  test("is off at 0 minutes", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        state.readings.set("cred-a", { at: 0, windows: [], refusal: { kind: "usage-limit", until: 2 * HOUR } })
        yield* start({ sweepMinutes: 0 }, state)
        yield* TestClock.adjust(HOUR)
        expect(ledgerKeys(state)).toEqual([])
      }),
    ))
})

describe("the RPC", () => {
  test("logins names the login each step of a session went out on, by its message, in the ledger too", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        // The ledger keys a step by its millisecond: each step here ends in its own.
        const step = (sessionID: string, assistantMessageID?: string) =>
          plugin
            .emit({ type: "session.step.ended", data: { sessionID, cost: 1, ...(assistantMessageID === undefined ? {} : { assistantMessageID }) } })
            .pipe(Effect.andThen(TestClock.adjust("1 second")))
        expect(yield* plugin.request("s1")).toBe("cred-a")
        yield* step("s1", "msg_1")
        // A 429 holds cred-a: the session's next request moves to cred-b.
        yield* plugin.respond(429, "s1")
        expect(yield* plugin.request("s1")).toBe("cred-b")
        yield* step("s1", "msg_2")
        // A step whose event names no message is left out; so is another session's.
        yield* step("s1")
        expect(yield* plugin.request("s2")).toBe("cred-b")
        yield* step("s2", "msg_3")
        expect(yield* plugin.logins({ sessionID: "s1" })).toEqual({
          steps: [
            { pool: "anthropic", messageID: "msg_1", credentialID: "cred-a" },
            { pool: "anthropic", messageID: "msg_2", credentialID: "cred-b" },
          ],
        })
        expect(yield* plugin.logins({ session: "s1" })).toEqual({ steps: [] })
        // A new process reads the steps' messages back from the ledger.
        const next = yield* start(undefined, state)
        expect((yield* next.logins({ sessionID: "s1" })).steps.map((step) => step.messageID)).toEqual(["msg_1", "msg_2"])
      }),
    ))

  test("pace admits unpooled models, holds the measured pool and picks up newer quota readings", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        const at = stamp()
        for (const id of ["cred-a", "cred-b"])
          state.readings.set(id, { at, windows: [{ name: "7d", utilization: 0.8, resetAt: at + 3.5 * 86400000 }] })
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: true, measured: false })
        expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: false, measured: true })
        for (const id of ["cred-a", "cred-b"])
          state.readings.set(id, { at, windows: [{ name: "7d", utilization: 0.2, resetAt: at + 3.5 * 86400000 }] })
        expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: true, measured: true })
      }),
    ))

  test("status lists each login's hold and reading, and never a token", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        yield* plugin.request()
        state.readings.set("cred-a", { at: stamp(), windows: [], refusal: { kind: "rate-limit", until: stamp() + 60_000 } })
        yield* plugin.respond(429)
        const status = yield* plugin.status
        expect(status.anthropic?.accounts.map((account) => [account.credentialID, account.hold?.kind])).toEqual([
          ["cred-a", "rate-limit"],
          ["cred-b", undefined],
        ])
        expect(JSON.stringify(status)).not.toContain("token")
      }),
    ))

  test("session names the login a session is on by its label, with its reading, and nothing for an unpooled provider", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state)
        // Before any request the pool has listed no login: nothing to name.
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "anthropic" })).toEqual({})
        expect(yield* plugin.request("ses_0")).toBe("cred-a")
        // Listed now: a session with no request yet sees the pool's pick for it.
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "anthropic" })).toMatchObject({
          account: { pool: "anthropic", credentialID: "cred-b", label: "Anthropic 2", on: "next" },
        })
        expect(yield* plugin.request("ses_1")).toBe("cred-b")
        const at = stamp()
        yield* plugin.publish({ credentialID: "cred-b", reading: { at, windows: [{ name: "7d", utilization: 0.41, resetAt: at + HOUR }] } })
        const placed: SessionAnswer = {
          account: {
            pool: "anthropic",
            credentialID: "cred-b",
            label: "Anthropic 2",
            on: "placed",
            // The 5-hour window the request's headers reported, which this reading leaves unsaid, is kept until its reset.
            reading: { at, windows: [{ name: "7d", utilization: 0.41, resetAt: at + HOUR }, expect.objectContaining({ name: "5h", at: expect.any(Number) })] },
          },
        }
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "anthropic" })).toEqual(placed)
        // Without a provider: the pool its newest request went through.
        expect(yield* plugin.session({ sessionID: "ses_1" })).toEqual(placed)
        expect(yield* plugin.session({ sessionID: "ses_1", providerID: "openai" })).toEqual({})
        expect(yield* plugin.session({ sessionID: "ses_never" })).toEqual({})
        expect(yield* plugin.session({ providerID: "anthropic" })).toEqual({})
        expect(JSON.stringify(yield* plugin.session({ sessionID: "ses_1" }))).not.toContain("token")
      }),
    ))

  test("pace on a pool whose logins cannot be read fails, dispatch holds with a retry, and status goes on", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.delete(ANTHROPIC)
        const plugin = yield* start(undefined, state)
        const dispatch = yield* Effect.flip(Effect.sandbox(plugin.request()))
        expect(Cause.pretty(dispatch)).toMatch(/the pool's logins could not be listed; it may go again at [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M (?:EST|EDT)/)
        expect((yield* Effect.exit(plugin.pace("anthropic")))._tag).toBe("Failure")
        expect((yield* plugin.status).anthropic?.accounts).toEqual([])
      }),
    ))
})

describe("on the live adapters", () => {
  test("a step's tokens reach the tally file this start names, at the next sweep", () =>
    onTestClock(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start({ sweepMinutes: 5 }, state, live())
        yield* TestClock.adjust(HOUR)
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        const opus = { providerID: "anthropic", id: "claude-opus-5-5" }
        const million = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", model: opus } })
        yield* plugin.emit({ type: "session.step.ended", data: { sessionID: "ses_1", cost: 4, assistantMessageID: "msg_1", tokens: million } })
        yield* TestClock.adjust(MINUTE)
        const reading = { at: HOUR + MINUTE, windows: [{ name: "5h", utilization: 0.02, resetAt: 5 * HOUR }] }
        state.readings.set("cred-a", reading)
        yield* plugin.publish({ credentialID: "cred-a", reading })
        yield* TestClock.adjust("5 minutes")
        yield* settle
        const written = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ line: Schema.NullOr(Schema.String) })))(readFileSync(plugin.limitsFile, "utf8"))
        expect(written.line).toContain("Opus")
      }),
    ))

  test("the pool reads the integration's OAuth logins and its quota RPC, keeps holds in storage, and asks a refused login to sign in", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const plugin = yield* start(undefined, state, live())
        expect(yield* plugin.request("ses_1")).toBe("cred-a")
        expect(yield* plugin.request("ses_2")).toBe("cred-b")
        // The integration's label names the login a session is on.
        expect((yield* plugin.session({ sessionID: "ses_2", providerID: "anthropic" })).account?.label).toBe("Anthropic 2")
        state.readings.set("cred-a", { at: stamp(), windows: [], refusal: { kind: "signin", until: stamp() + 30 * 60_000 } })
        yield* plugin.respond(401)
        expect(state.storage.has("anthropic/hold/cred-a")).toBe(true)
        expect(new Set(plugin.quotaIDs)).toEqual(new Set(["credential-quota.anthropic"]))
        expect(plugin.statuses).toEqual([
          { credentialID: "cred-a", status: { status: "needs_auth", message: expect.stringContaining("sign in") } },
        ])
        // A reading published over the quota RPC holds a login too.
        yield* plugin.publish({
          credentialID: "cred-b",
          reading: { at: stamp(), windows: [], refusal: { kind: "rate-limit", until: stamp() + 60_000 } },
        })
        expect(state.storage.has("anthropic/hold/cred-b")).toBe(true)
        expect(Object.keys(plugin.rpc)).toEqual(["dotfiles-opencode.pool"])
      }),
    ))

  test("a login store joins the anthropic pool, which OpenCode then offers without a login of its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-store-"))
    return scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "store", dir }] }, world(), live())
        expect((yield* plugin.status).anthropic?.sources).toEqual([{ kind: "store", dir, accounts: [], skipped: [] }])
        let activation = "auto"
        const editor = {
          get: () => ({ provider: { activation } }),
          update: (_: string, change: (provider: { activation: string }) => void) => {
            const provider = { activation }
            change(provider)
            activation = provider.activation
          },
        }
        expect(plugin.transforms).toHaveLength(1)
        for (const transform of plugin.transforms) transform(editor)
        expect(activation).toBe("enabled")
      }),
    ).finally(() => rmSync(dir, { recursive: true, force: true }))
  })

  test("a hold an older pool kept under a store login's legacy id still holds that login, under its id now", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-store-"))
    mkdirSync(join(dir, ".slots/anthropic"), { recursive: true })
    // A store sign-in good until 2100, with a current hold.
    writeFileSync(
      join(dir, ".slots/anthropic/work"),
      '{"_tag":"Oauth","type":"oauth","access":"fake-access-legacy","refresh":"fake-refresh-legacy","expires":4102444800000,"accountId":null,"metadata":{"owner":"store"}}',
      { mode: 0o600 },
    )
    const state = world()
    const hold = { kind: "usage-limit" as const, until: HOUR, at: 0 }
    state.storage.set(`anthropic/hold/${LEGACY_PREFIX}work`, hold)
    return onTestClock(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "store", dir }] }, state, live())
        // The held login is passed over.
        expect(yield* plugin.request("ses_1")).not.toBe("store:work")
        const status = yield* plugin.status
        const work = status.anthropic?.accounts.find((account) => account.credentialID === "store:work")
        expect(work?.hold).toEqual(hold)
        expect(state.storage.has(`anthropic/hold/${LEGACY_PREFIX}work`)).toBe(false)
        expect(state.storage.get("anthropic/hold/store:work")).toEqual(hold)
      }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))),
    )
  })
})

describe("the alerts RPC", () => {
  /** A login store with one expired login, and a source over it that trades at a fake endpoint answering `status`. */
  const store = (status: number, headers: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "pool-alerts-"))
    mkdirSync(join(dir, ".slots/anthropic"), { recursive: true })
    const login = { access: "fake-access-alerts", refresh: "fake-refresh-alerts" }
    writeFileSync(
      join(dir, ".slots/anthropic/work"),
      JSON.stringify({ _tag: "Oauth", type: "oauth", ...login, expires: stamp() - 1000, accountId: null, metadata: { owner: "store" } }),
      { mode: 0o600 },
    )
    // A second source over the directory shares the plugin's state for it, as every copy in the process does.
    const trader = new StoreSource({
      dir,
      fetch: async () => Response.json({ error: "refused" }, { status, headers }),
    })
    const trade = Effect.promise(() => trader.resolve("store:work").then(() => "served", () => "failed"))
    return { dir, login, trade }
  }

  test("names a store login the endpoint refused, with the slot file to sign it in to again, and never its token", () => {
    const { dir, login, trade } = store(400)
    return scenario(
      Effect.gen(function* () {
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "store", dir }] }, world(), live())
        expect(yield* plugin.alerts).toEqual({ lost: [], outages: [] })
        expect(yield* trade).toBe("failed")
        const alerts = yield* plugin.alerts
        expect(alerts).toEqual({
          lost: [
            {
              pool: "anthropic",
              credentialID: "store:work",
              label: "work",
              since: expect.any(Number),
              slot: join(dir, ".slots/anthropic/work"),
            },
          ],
          outages: [],
        })
        expect(JSON.stringify(alerts)).not.toContain(login.access)
        expect(JSON.stringify(alerts)).not.toContain(login.refresh)
      }),
    ).finally(() => rmSync(dir, { recursive: true, force: true }))
  })

  test("names a store whose refreshes have failed for refreshOutageMinutes, with the endpoint's status, server and retry-after", () => {
    const { dir, trade } = store(429, { server: "cloudflare", "retry-after": "600" })
    return scenario(
      Effect.gen(function* () {
        // A threshold of 30 ms: one 429 that pauses the store for ten minutes is out once it passes.
        const plugin = yield* start({ sweepMinutes: 0, sources: [{ kind: "store", dir }], refreshOutageMinutes: 0.0005 }, world(), live())
        expect(yield* trade).toBe("failed")
        yield* Effect.promise(() => new Promise((done) => setTimeout(done, 50)))
        expect(yield* plugin.alerts).toEqual({
          lost: [],
          outages: [
            {
              pool: "anthropic",
              dir,
              since: expect.any(Number),
              lastAt: expect.any(Number),
              failures: 1,
              cause: { status: 429, server: "cloudflare", retryAfter: "600" },
            },
          ],
        })
      }),
    ).finally(() => rmSync(dir, { recursive: true, force: true }))
  })

  test("a refreshOutageMinutes that is not a positive number stops the plugin", async () => {
    for (const refreshOutageMinutes of [0, -1, "10"]) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ sweepMinutes: 0, refreshOutageMinutes }))))
      expect(exit._tag).toBe("Failure")
    }
  })

  test("a pool with no login store has no alerts", () =>
    scenario(
      Effect.gen(function* () {
        expect(yield* (yield* start()).alerts).toEqual({ lost: [], outages: [] })
      }),
    ))
})

describe("the fleet", () => {
  const DAY = 86_400_000
  /** A weekly reading `utilization` spent, halfway through the week, at `at`. */
  const week = (utilization: number, at: number): QuotaReading => ({ at, windows: [{ name: "7d", utilization, resetAt: at + 3.5 * DAY }] })
  const FLEET = { host: "mac", peers: [{ name: "workbox", ssh: "bite-workbox" }, { name: "laptop", ssh: "laptop" }], startCost: 0.1 }

  test("a peer's recent starts count on the pace here, its newer readings join, and a peer that cannot be read is named and skipped", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const now = stamp()
        state.readings.set("cred-b", week(0.45, now - 1_000))
        state.peers.set("workbox", {
          host: "bite-cristian",
          at: now,
          starts: [1, 2, 3].map((n) => ({ providerID: "anthropic", at: now - n * 60_000 })),
          // cred-a is read only there; a login this pool does not list is left out.
          readings: [
            { pool: "anthropic", credentialID: "cred-a", reading: week(0.45, now - 500) },
            { pool: "anthropic", credentialID: "store:elsewhere", reading: week(1, now - 500) },
          ],
        })
        state.peers.set("laptop", { down: "ssh: connect to host laptop port 22: Connection refused" })
        const plugin = yield* start({ sweepMinutes: 0, fleet: FLEET }, state)
        yield* settle
        expect(yield* plugin.fleet).toEqual({
          host: "mac",
          starts: 0,
          settleMinutes: 10,
          peers: [
            { name: "workbox", host: "bite-cristian", seenAt: expect.any(Number), starts: 3 },
            { name: "laptop", starts: 0, missed: { since: expect.any(Number), message: "ssh: connect to host laptop port 22: Connection refused" } },
          ],
        })
        // 90% read across two accounts halfway through their week is on pace; the three starts are 30% more.
        const pace = yield* plugin.pace("anthropic")
        expect(pace).toMatchObject({ ok: false, measured: true })
        expect(pace.reason).toBe(
          "the pool's weekly pace is over: its 2 accounts' weeks are at 45.0% used of 100% on average, plus 15.0% of the week counted for 3 agents started in the last 10 min, plus 5.0% of the week reserved for the next agent; " +
            "the spend-evenly line averages 54.5% used of 100% now, and the start holds past it",
        )
        // It holds until the oldest start settles, sooner than the week catches up.
        expect(pace.ok ? 0 : pace.retryAt).toBe(now - 3 * 60_000 + 10 * 60_000 + 1)
        // The pace read cred-b here; cred-a's reading came from the workbox.
        expect((yield* plugin.status).anthropic?.accounts.map((account) => [account.credentialID, account.reading?.at])).toEqual([
          ["cred-a", now - 500],
          ["cred-b", now - 1_000],
        ])
      }),
    ))

  test("started records a new agent on this host, the report tells a peer of it with the readings and no token, and the pace counts it", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const now = stamp()
        state.readings.set("cred-a", week(0.49, now))
        state.readings.set("cred-b", week(0.49, now))
        const plugin = yield* start({ sweepMinutes: 0, fleet: { host: "mac", startCost: 0.1 } }, state)
        expect(yield* plugin.pace("anthropic")).toMatchObject({ ok: true })
        expect(yield* plugin.started({ providerID: "anthropic" })).toEqual({})
        // A malformed question records nothing; a provider this pool does not pace is reported but not counted here.
        expect(yield* plugin.started({ provider: "anthropic" })).toEqual({})
        yield* plugin.started({ providerID: "openai" })
        // A session busy on a step: an agent running, told to the peer until it goes idle.
        yield* plugin.emit({ type: "session.step.started", data: { sessionID: "ses_busy", assistantMessageID: "msg_busy", model: { providerID: "anthropic", id: "claude-opus-5-5" } } })
        const report = yield* plugin.report
        // The starts are a set: two in the same millisecond come back in either order.
        expect(report.starts.map((start) => start.providerID).sort()).toEqual(["anthropic", "openai"])
        expect(report).toEqual({
          host: "mac",
          launchProtocol: 1,
          at: expect.any(Number),
          starts: expect.arrayContaining([
            { providerID: "anthropic", cost: 0.1, at: expect.any(Number) },
            { providerID: "openai", cost: 0.1, at: expect.any(Number) },
          ]),
          busy: ["anthropic"],
          readings: [
            { pool: "anthropic", credentialID: "cred-a", reading: week(0.49, now) },
            { pool: "anthropic", credentialID: "cred-b", reading: week(0.49, now) },
          ],
          // No step has counted yet: the limit tally tells the peer of no tokens.
          limits: { since: expect.any(Number), rows: [] },
        })
        expect(JSON.stringify(report)).not.toContain("token")
        yield* plugin.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_busy" } })
        expect((yield* plugin.report).busy).toEqual([])
        expect((yield* plugin.fleet).starts).toBe(2)
        expect((yield* plugin.pace("anthropic")).reason).toContain("plus 5.0% of the week counted for 1 agent started in the last 10 min")
      }),
    ))

  test("the plugin's instances on one host (one per directory) share the fleet: a start in one counts in the other, and they share the peer reads", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        const now = stamp()
        state.readings.set("cred-a", week(0.5, now))
        state.readings.set("cred-b", week(0.5, now))
        // Each read of a peer looks its answer up once.
        let reads = 0
        const peers = new (class extends Map<string, PeersTest.Answer> {
          override get(name: string) {
            reads += 1
            return super.get(name)
          }
        })([["workbox", { host: "bite-cristian", at: now, starts: [], readings: [] }]])
        const shared: World = { ...state, peers }
        const fleet = { host: "mac", startCost: 0.1, pollSeconds: 30, peers: [{ name: "workbox", ssh: "bite-workbox" }] }
        // Both instances run over the same storage, as OpenCode's are over the host's.
        const project = yield* start({ sweepMinutes: 0, fleet }, shared)
        const home = yield* start({ sweepMinutes: 0, fleet }, shared)
        yield* settle
        // Both instances' polls ran; only the first read the peer.
        expect(reads).toBe(1)
        expect((yield* home.fleet).peers).toEqual([{ name: "workbox", host: "bite-cristian", seenAt: expect.any(Number), starts: 0 }])
        yield* project.started({ providerID: "anthropic" })
        expect((yield* home.fleet).starts).toBe(1)
        expect((yield* home.report).starts).toEqual([{ providerID: "anthropic", cost: 0.1, at: expect.any(Number) }])
        expect((yield* home.pace("anthropic")).reason).toContain("plus 5.0% of the week counted for 1 agent started in the last 10 min")
      }),
    ))

  test("malformed fleet options stop the plugin", async () => {
    for (const fleet of [{ peers: [{ name: "workbox" }] }, { pollSeconds: 0 }, { startCost: 2 }, { host: "" }]) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ sweepMinutes: 0, fleet }))))
      expect(exit._tag).toBe("Failure")
    }
  })
})

describe("a paced provider on the live adapters", () => {
  const OPENAI = PoolId.make("openai")
  const DAY = 86_400_000

  test("OpenAI's pace reads the ChatGPT account's usage, then what its responses and frames show, and its requests are never placed", () => {
    const resetAt = Math.round((stamp() + 3.5 * DAY) / 1000)
    const seen: Array<string | null> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen.push(request.headers.get("chatgpt-account-id"))
        return request.headers.get("authorization") === "Bearer chatgpt-access"
          ? Response.json({
              plan_type: "pro",
              rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: resetAt } },
            })
          : new Response("unauthorized", { status: 401 })
      },
    })
    return scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.set(OPENAI, [{ type: "credential", id: "chatgpt-1", label: "ChatGPT", method: "oauth" }])
        state.credentials.set("chatgpt-1", {
          type: "oauth",
          methodID: "browser",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: stamp() + DAY,
          metadata: { accountID: "acct-1" },
        })
        state.active.set("openai", "chatgpt-1")
        const plugin = yield* start({ sweepMinutes: 0, paced: { openai: "openai" }, usageURL: `${server.url.origin}/backend-api/wham/usage` }, state, live())
        // 80% of the week spent halfway through it: over the pace.
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: false, measured: true })
        expect(seen).toEqual(["acct-1"])
        expect(yield* plugin.request("ses_1", "openai")).toBeUndefined()
        // A response's headers say 20%: the pace opens, without asking the endpoint again.
        yield* plugin.responded("openai", {
          "x-codex-primary-used-percent": "20",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": String(resetAt),
        })
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: true, measured: true })
        // A websocket frame says 95%: held again.
        yield* plugin.received(
          "openai",
          JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 95, window_minutes: 10_080, reset_at: resetAt } } }),
        )
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: false, measured: true })
        expect(seen).toEqual(["acct-1"])
        // The anthropic pool still reads its auth plugin; OpenAI's is not asked.
        expect(plugin.quotaIDs).not.toContain("credential-quota.openai")
        const status = JSON.stringify(yield* plugin.status)
        expect(status).toContain("chatgpt-1")
        expect(status).not.toContain("chatgpt-access")
        expect(status).not.toContain("chatgpt-refresh")
      }),
    ).finally(() => server.stop(true))
  })

  test("a ChatGPT login that cannot be read leaves the pace open", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.set(OPENAI, [{ type: "credential", id: "chatgpt-1", label: "ChatGPT", method: "oauth" }])
        const plugin = yield* start({ sweepMinutes: 0, paced: { openai: "openai" }, usageURL: "http://127.0.0.1:9/none" }, state, live())
        expect(yield* plugin.pace("openai")).toMatchObject({ ok: true, measured: false })
      }),
    ))
})

describe("resets on the live adapters", () => {
  const OPENAI = PoolId.make("openai")
  const DAY = 86_400_000

  /** A Claude login whose 5-hour window is spent, its week resetting in three days, with a grant of two resets (not the last one, kept). */
  const spentClaude = (now: number): QuotaReading => ({
    at: now,
    windows: [
      { name: "5h", utilization: 1, resetAt: now + 2 * HOUR },
      { name: "7d", utilization: 0.4, resetAt: now + 3 * DAY },
    ],
    resets: {
      available: 1,
      credits: [{ id: "grant-1", count: 2, usable: true, expiresAt: now + 120 * DAY, clears: ["five_hour", "seven_day_overage_included"] }],
    },
  })

  /** Three sessions busy on the provider, each on a step: work running, enough for a held start's reset to pay. */
  const busy = (plugin: { readonly emit: (event: SessionEvent) => Effect.Effect<unknown, unknown> }, providerID: string) =>
    Effect.forEach(
      [1, 2, 3],
      (n) =>
        plugin.emit({ type: "session.step.started", data: { sessionID: `ses_busy_${n}`, assistantMessageID: `msg_busy_${n}`, model: { providerID, id: "agent-model" } } }),
      { discard: true },
    )

  test("every Codex account spent, a start held and work running: the pool consumes one credit, once, on the ChatGPT backend, and only tells the owner", async () => {
    const reply = Promise.withResolvers<void>()
    const fake = startFakeChatGPT({ beforeConsumeResponse: () => reply.promise })
    const now = stamp()
    // The credit ends before the week resets: not one to keep in hand.
    fake.accounts.set("acct-1", spentAccount("access-1", "credit-1", now, 100, 2 * DAY))
    try {
      await scenario(
        Effect.gen(function* () {
          const state = world()
          state.integration.connections.set(OPENAI, [{ type: "credential", id: "chatgpt-1", label: "ChatGPT", method: "oauth" }])
          state.credentials.set("chatgpt-1", { type: "oauth", access: "access-1", refresh: "r", expires: now + DAY, metadata: { accountID: "acct-1" } })
          state.active.set(OPENAI, "chatgpt-1")
          const plugin = yield* start({ sweepMinutes: 0, paced: { openai: "openai" }, usageURL: fake.usageURL }, state, live())
          yield* busy(plugin, "openai")
          expect(yield* plugin.pace("openai", "ses_root")).toMatchObject({ ok: false, measured: true })
          yield* waitFor("the fake's consume request", () => fake.consumes.length > 0)
          yield* plugin.pace("openai", "ses_root")
          // Consumption precedes the HTTP reply and the post-claim usage read.
          // Keep that boundary open: a second pace must not lose or duplicate the claim.
          const pending = yield* plugin.resets
          expect(pending.claims).toEqual([])
          expect(pending.resets.map((reset) => reset.stage)).toEqual(["claiming"])
          reply.resolve()
          // Observe completion through the public RPC, not a fixed sleep after consumption.
          const resets = yield* plugin.resets.pipe(
            Effect.repeat({ until: (status) => status.claims.length > 0, schedule: Schedule.spaced("5 millis") }),
            Effect.timeout("1 second"),
          )
          yield* plugin.pace("openai", "ses_root")
          expect(fake.consumes.map(({ account, creditID, code }) => ({ account, creditID, code }))).toEqual([
            { account: "acct-1", creditID: "credit-1", code: "reset" },
          ])
          expect(String(fake.consumes[0]?.requestID)).toMatch(/^pool-[0-9a-f]{24}$/)
          yield* waitFor("the notice", () => state.owner.asked.length > 0)
          expect(state.owner.asked.map(({ header, options }) => [header, options.map((option) => option.label)])).toEqual([["Pool reset claimed", ["OK"]]])
          expect(resets.claims.map(({ provider, outcome, weekly }) => ({ provider, outcome, weekly }))).toEqual([
            { provider: "codex", outcome: "reset", weekly: "moved" },
          ])
          expect(JSON.stringify(resets)).not.toContain("access-1")
        }),
      )
    } finally {
      reply.resolve()
      await fake.stop()
    }
  })

  test("a Claude login with work running: the grant is claimed on its own, and the owner told after in the waiting subagent's root session", () =>
    scenario(
      Effect.gen(function* () {
        const now = stamp()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        state.readings.set("cred-a", spentClaude(now))
        state.parents.set("ses_child", "ses_root")
        const plugin = yield* start({ sweepMinutes: 0 }, state, live())
        yield* busy(plugin, "anthropic")
        expect(yield* plugin.pace("anthropic", "ses_child")).toMatchObject({ ok: false, measured: true })
        yield* waitFor("the plugin's claim and the notice", () => plugin.claims.length > 0 && state.owner.asked.length > 0)
        expect(plugin.claims.map(({ credentialID, creditID }) => [credentialID, creditID])).toEqual([["cred-a", "grant-1"]])
        const told = state.owner.asked[0]! as OwnerTest.MemoryOwner["asked"][number] & { readonly plugin?: string }
        expect(state.owner.asked).toHaveLength(1)
        expect(told).toMatchObject({ sessionID: "ses_root", plugin: "dotfiles-opencode.pool", header: "Pool reset claimed", options: [{ label: "OK" }] })
        expect(told.question).toStartWith("Claimed the full reset on Anthropic 1: 5h 100% used of 100% → 0% used (the account reached its limit: 5h 100% used, 3 agents running, 1 start held; refill the measured limit)")
        expect(told.question).toContain("1 reset left this week")
        const resets = yield* plugin.resets
        expect(resets.claims.map(({ provider, outcome, weekly }) => ({ provider, outcome, weekly }))).toEqual([
          { provider: "claude", outcome: "reset", weekly: "kept" },
        ])
      }),
    ))

  test("a held start with nothing else running still counts: its only account spent, the grant refills the measured limit, and nothing asked", () =>
    scenario(
      Effect.gen(function* () {
        const now = stamp()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        state.readings.set("cred-a", spentClaude(now))
        const plugin = yield* start({ sweepMinutes: 0 }, state, live())
        expect(yield* plugin.pace("anthropic", "ses_root")).toMatchObject({ ok: false })
        yield* waitFor("the plugin's claim", () => plugin.claims.length > 0)
        expect(plugin.claims.map(({ creditID }) => creditID)).toEqual(["grant-1"])
        expect((yield* plugin.resets).resets.map((reset) => reset.why)).toEqual(["forecast"])
        expect(state.owner.asked.every((question) => question.header === "Pool reset claimed")).toBe(true)
      }),
    ))

  test("a Claude reset about to expire unused is claimed with no one asked, and the owner is told after in the waiting session's root", () =>
    scenario(
      Effect.gen(function* () {
        const now = stamp()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        // Fable's own week spent, resetting in five days; its reset ends in two hours: lost unless claimed now.
        state.readings.set("cred-a", {
          at: now,
          windows: [
            { name: "5h", utilization: 1, resetAt: now + 3 * HOUR },
            { name: "7d", utilization: 0.6, resetAt: now + 5 * DAY },
            { name: "7d:Fable", utilization: 1, resetAt: now + 5 * DAY, ofWeekly: 0.5 },
          ],
          resets: {
            available: 1,
            credits: [{ id: "fable-1", count: 1, usable: true, expiresAt: now + 2 * HOUR, clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }],
          },
        })
        state.parents.set("ses_child", "ses_root")
        const plugin = yield* start({ sweepMinutes: 0 }, state, live())
        expect(yield* plugin.pace("anthropic", "ses_child")).toMatchObject({ ok: false, measured: true })
        yield* waitFor("the plugin's claim and the owner's question", () => plugin.claims.length > 0 && state.owner.asked.length > 0)
        expect(plugin.claims.map(({ credentialID, creditID }) => [credentialID, creditID])).toEqual([["cred-a", "fable-1"]])
        // No question before the claim: the one asked is the notice after it.
        expect(state.owner.asked).toHaveLength(1)
        expect(state.owner.asked[0]).toMatchObject({ sessionID: "ses_root", header: "Pool reset claimed", options: [{ label: "OK" }] })
        expect(state.owner.asked[0]?.question).toStartWith("Claimed the Fable reset on Anthropic 1: ")
        expect(state.owner.asked[0]?.question).toContain("(about to expire unused: ")
        // Read, it leaves the tray.
        // The reading the memory quota keeps still lists the grant: it is not offered again under another key.
        yield* OwnerTest.answer(state.owner, state.owner.asked[0]!.key, "OK")
        yield* waitFor("the owner's question to close", () => state.owner.questions.size === 0)
        yield* plugin.pace("anthropic", "ses_child")
        yield* settle
        expect(state.owner.asked).toHaveLength(1)
        expect(plugin.claims).toHaveLength(1)
        expect((yield* plugin.resets).resets.map(({ why, kind, stage }) => ({ why, kind, stage }))).toEqual([{ why: "expiring", kind: "fable", stage: "settled" }])
      }),
    ))

  test("resets: { auto: false } claims nothing on its own, and asks nothing: the reset about to expire is left, and so is the held work's", () =>
    scenario(
      Effect.gen(function* () {
        const now = stamp()
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        // As above: Fable's week spent, its reset ends in two hours; with auto on it is claimed at once.
        state.readings.set("cred-a", {
          at: now,
          windows: [
            { name: "5h", utilization: 1, resetAt: now + 3 * HOUR },
            { name: "7d", utilization: 0.6, resetAt: now + 5 * DAY },
            { name: "7d:Fable", utilization: 1, resetAt: now + 5 * DAY, ofWeekly: 0.5 },
          ],
          resets: {
            available: 1,
            credits: [{ id: "fable-1", count: 1, usable: true, expiresAt: now + 2 * HOUR, clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }],
          },
        })
        state.parents.set("ses_child", "ses_root")
        const plugin = yield* start({ sweepMinutes: 0, resets: { auto: false } }, state, live())
        yield* busy(plugin, "anthropic")
        expect(yield* plugin.pace("anthropic", "ses_child")).toMatchObject({ ok: false, measured: true })
        yield* settle
        yield* plugin.pace("anthropic", "ses_child")
        yield* settle
        expect(plugin.claims).toEqual([])
        expect(state.owner.asked).toEqual([])
      }),
    ))

  test("malformed resets options stop the plugin", async () => {
    for (const resets of [{ auto: "no" }, "yes", 1]) {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(start({ sweepMinutes: 0, resets }))))
      expect(exit._tag).toBe("Failure")
    }
  })

  test("resets: false works none", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]!])
        state.readings.set("cred-a", spentClaude(stamp()))
        const plugin = yield* start({ sweepMinutes: 0, resets: false }, state, live())
        expect(yield* plugin.pace("anthropic", "ses_root")).toMatchObject({ ok: false })
        yield* settle
        expect(state.owner.asked).toEqual([])
        expect(yield* plugin.resets).toEqual({ resets: [], claims: [] })
      }),
    ))
})

describe("the lease RPC", () => {
  test("a peer's ask reaches the process's leases, which lend nothing while the process is newly started (it may have lent a lease it forgot); a release is taken; a malformed message lends nothing", () =>
    scenario(
      Effect.gen(function* () {
        const plugin = yield* start()
        const lease = plugin.rpc["dotfiles-opencode.pool"]!.lease!
        const now = stamp()
        const grants = [`grant-rpc-${now}`]
        const ask = (host: string, id: string) => ({ _tag: "Ask", host, id, provider: "claude", grants, readAt: now, requestedAt: now, holdMs: 60_000 })
        expect(yield* lease({ _tag: "Ask", host: "mac" })).toEqual({ granted: false, reason: "not a lease message" })
        // The grant, the refusal while lent and the release are lease.test.ts's and fleet-claims.test.ts's: the table here is the process's.
        expect(yield* lease(ask("mac", "a"))).toMatchObject({ granted: false, reason: expect.stringContaining("started lately and lends nothing until") })
        expect(yield* lease({ _tag: "Release", host: "mac", id: "a", provider: "claude", grants })).toEqual({ granted: true })
      }),
    ))
})

describe("the push", () => {
  test("pool_push starts a push from the calling session and answers with its plan; the push RPC takes the same request, and a malformed one changes nothing", () =>
    scenario(
      Effect.gen(function* () {
        const state = world()
        // The test layers' owner walks the sessions' parents.
        state.owner.parents.set("ses_child", "ses_owner")
        const plugin = yield* start({ sweepMinutes: 0, fleet: { host: "workbox" } }, state)
        const tool = plugin.tools.get("pool_push")
        expect(tool).toBeDefined()
        const answer = yield* tool!.execute({ action: "start", goal: "ergo", session: true, resets: 1 } as never, { sessionID: "ses_child" })
        expect(answer.content[0]!.text).toContain('Push push-workbox_ses_owner__-')
        expect(answer.content[0]!.text).toContain('"ergo" (asked): host workbox, session ses_owner')
        const push = plugin.rpc["dotfiles-opencode.pool"]!.push!
        expect(yield* push({ action: "status" })).toMatchObject({ ok: true, pushes: [{ goal: "ergo", scope: { host: "workbox", sessionID: "ses_owner" } }] })
        expect(yield* push({ action: "launch" })).toEqual({ ok: false, text: "not a push request", pushes: [] })
        // A refusal is the tool's error, with the reason.
        const refused = yield* tool!.execute({ action: "start", goal: "" } as never, { sessionID: "ses_child" }).pipe(Effect.flip)
        expect(String((refused as { message?: string }).message)).toContain("A push needs a goal")
      }),
    ))
})

/** The host's files and paths as the fork's plugin host gives them, here a file system that does nothing. */
const HOST_FILES = Layer.mergeAll(FileSystem.layerNoop({}), Path.layer)

const AGY_ROWS = ["antigravity / Gemini · open", "  read Nov 24, 2026, 8:00:00 PM EST (now)"]

/** An Antigravity source that answers its rows and reads nothing. */
const agySource: AgySource.Source = {
  lines: Effect.succeed(AGY_ROWS),
  report: Effect.succeed({ host: "mac", at: 0, readableSignIn: true, limits: [] }),
  open: () => Effect.succeed([]),
  record: () => Effect.succeed(Option.none()),
  clear: () => Effect.void,
  read: () => Effect.succeed({ note: "Read now.", lines: AGY_ROWS }),
  gate: () => Effect.succeed(GateDecision.cases.Admitted.make({ group: "gemini", measured: true, answer: AgyAnswer.cases.Open.make({}), geminiFleetCount: 0, geminiAgentCount: 0 })),
  heartbeat: () => Effect.void,
  release: () => Effect.void,
}

/** The `antigravity` tool's text for `action`, through the tool the plugin registered. */
const agyTool = (plugin: { readonly tools: ReadonlyMap<string, ToolDefinition> }, action: string) =>
  Effect.gen(function* () {
    const tool = yield* Option.match(Option.fromUndefinedOr(plugin.tools.get("antigravity")), {
      onNone: () => Effect.die("the antigravity tool is not registered"),
      onSome: Effect.succeed,
    })
    const answer = yield* tool.execute({ action }, { sessionID: "ses_1" })
    return answer.content.map((part) => part.text).join("\n")
  })

describe("Antigravity, composed as OpenCode composes the pool", () => {
  test("the root runs under the host's files and paths, is called with the option, and the tool, the RPC and a status answer from it", () =>
    scenario(
      Effect.gen(function* () {
        const calls: Array<AgyLive.PoolOption> = []
        // Shaped as the live root is: it needs the host's FileSystem and Path, so the plugin does too.
        const root: AntigravityRoot<AntigravityHost> = (option) =>
          Effect.gen(function* () {
            yield* FileSystem.FileSystem
            yield* Path.Path
            calls.push(option)
            return Option.some(agySource)
          })
        const plugin = yield* start({ sweepMinutes: 0, antigravity: { auth: "business" } }, world(), "test", true, root)
        expect(calls).toEqual([{ auth: "business" }])
        expect(yield* agyTool(plugin, "status")).toBe(AGY_ROWS.join("\n"))
        expect(yield* agyTool(plugin, "read")).toBe(["Read now.", ...AGY_ROWS].join("\n"))
        const method = yield* Effect.flatMap(registered(plugin.rpc, "dotfiles-opencode.pool"), (handlers) => registered(handlers, "antigravity"))
        expect(yield* method({})).toEqual({ lines: AGY_ROWS })
        const gate = yield* method({ action: "gate", model: "gemini-3-pro" })
        expect(gate).toEqual({
          gate: { allowed: true, group: "gemini", measured: true, geminiFleetCount: 0, geminiAgentCount: 0, text: expect.stringContaining("admitted (gemini)") },
          lines: AGY_ROWS,
        })
        const reportMethod = yield* Effect.flatMap(registered(plugin.rpc, "dotfiles-opencode.pool"), (handlers) => registered(handlers, "report"))
        expect(yield* reportMethod({})).toMatchObject({ antigravity: { host: "mac", readableSignIn: true, limits: [] } })
      }).pipe(Effect.provide(HOST_FILES)),
    ))

  test("each reason for no source says its own cause: 'off' only when the option is false, a failed build its reason with the option on", () =>
    scenario(
      Effect.gen(function* () {
        // The option off, through the live root: no source, built with no I/O.
        const off = yield* start({ sweepMinutes: 0, antigravity: false }, world(), "test", true, liveAntigravity)
        expect(yield* agyTool(off, "status")).toBe("Antigravity's quota is not read on this host: the pool's antigravity option is off.")
        // The option on, the root failing or dying: never "off".
        for (const failing of [
          (() => Effect.die(new TypeError("root threw"))) satisfies AntigravityRoot,
          (() => Effect.flatMap(Path.Path, () => Effect.die(new RangeError("root died")))) satisfies AntigravityRoot<AntigravityHost>,
        ]) {
          const plugin = yield* start({ sweepMinutes: 0, antigravity: {} }, world(), "test", true, failing)
          const text = yield* agyTool(plugin, "status")
          expect(text).not.toContain("option is off")
          expect(text).toMatch(/^antigravity · unavailable: its source did not build on this host \((TypeError|RangeError)\); the antigravity option is on$/)
          const method = yield* Effect.flatMap(registered(plugin.rpc, "dotfiles-opencode.pool"), (handlers) => registered(handlers, "antigravity"))
          expect(yield* method({})).toEqual({ lines: [text] })
        }
      }).pipe(Effect.provide(HOST_FILES)),
    ))
})

describe("interim hold-wake on hosts without a Step", () => {
  /** Moves the test clock in `step`s, letting the plugin's fibers (and the live adapters' I/O) take each one in. */
  const advance = (ms: number, step = 30_000) =>
    Effect.gen(function* () {
      for (let left = ms; left > 0; left -= step) {
        yield* TestClock.adjust(Math.min(step, left))
        yield* settle
      }
    })
  /** The wakes the host admitted for `sessionID` (a repeated id is refused, so it is not among them). */
  const admittedFor = (state: World, sessionID: string) => state.synthetics.filter((entry) => entry.sessionID === sessionID)
  /** A world with one Anthropic login held until `until` and `child` a subagent of `ses_root`. */
  const heldWorld = (until: number, child = "ses_child") => {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    state.parents.set(child, "ses_root")
    state.storage.set("anthropic/hold/cred-a", { kind: "rate-limit", at: 0, until })
    return state
  }

  test("a held subagent's error states it resumes by itself unless stopped first; a root's and an auxiliary request's do not", () =>
    onTestClock(Effect.gen(function* () {
      const until = 10 * MINUTE
      const state = heldWorld(until)
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      const childError = yield* refusalOf(plugin.request("ses_child"))
      expect(childError).toContain(HoldWake.SUBAGENT_RESUME_NOTE)
      const rootError = yield* refusalOf(plugin.request("ses_root"))
      expect(rootError).not.toContain(HoldWake.SUBAGENT_RESUME_NOTE)
      const titleError = yield* refusalOf(plugin.request("ses_child", "anthropic", "title"))
      expect(titleError).not.toContain(HoldWake.SUBAGENT_RESUME_NOTE)
      expect(state.storage.get("held-send/ses_child")).toMatchObject({ sessionID: "ses_child", model: model.id, retryAt: until })
      expect(yield* plugin.heldSend("ses_child")).toEqual({
        state: "held",
        hold: { sessionID: "ses_child", providerID: "anthropic", reasonCode: "account-held", retryAt: until },
      })
      const lateHandoff = yield* plugin.handoff("cred-a", "ses_child")
      expect(Schema.is(Handoff.cases.Held)(lateHandoff)).toBe(true)
      if (Schema.is(Handoff.cases.Held)(lateHandoff)) expect(lateHandoff.message).toContain(HoldWake.SUBAGENT_RESUME_NOTE)
    })))

  test("a stopped subagent is not woken by the host when its hold opens, its notice gives way to a newer task, and a restart never wakes it again", () =>
    onTestClock(Effect.gen(function* () {
      const until = 2 * MINUTE
      const state = heldWorld(until, "ses_stopped")
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      expect(yield* refusalOf(plugin.request("ses_stopped"))).toContain(HoldWake.SUBAGENT_RESUME_NOTE)
      state.stopped.add("ses_stopped")
      yield* advance(until + MINUTE)
      expect(state.synthetics).toHaveLength(1)
      expect(state.synthetics[0]).toMatchObject({
        sessionID: "ses_stopped",
        id: HoldWake.wakeDeliveryId("ses_stopped", until),
        text: HoldWake.WAKE_TEXT,
        resume: true,
        woke: false,
      })
      // The host keeps a stopped Session's notice for its next task: the notice itself says that task wins.
      expect(HoldWake.WAKE_TEXT).toContain("If a newer task came with this notice, do that task instead")
      expect(state.storage.get("held-send/ses_stopped")).toMatchObject({ wokenAt: until })
      // A fresh pool copy after restart sees wokenAt and sends nothing more.
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* advance(5 * MINUTE)
      expect(state.synthetics).toHaveLength(1)
    })))

  test("a failed wake delivery is tried again: the held child is woken exactly once, and the row records only what the host took", () =>
    onTestClock(Effect.gen(function* () {
      const until = 2 * MINUTE
      const state = heldWorld(until)
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      yield* refusalOf(plugin.request("ses_child"))
      state.wakeAccess.fails = 1
      yield* advance(until + 10 * MINUTE)
      expect(admittedFor(state, "ses_child")).toHaveLength(1)
      expect(admittedFor(state, "ses_child")[0]).toMatchObject({ id: HoldWake.wakeDeliveryId("ses_child", until), text: HoldWake.WAKE_TEXT, woke: true })
      expect(state.wakeAccess.calls).toBe(2)
      expect(state.storage.get("held-send/ses_child")).toMatchObject({ retryAt: until, wakeFailures: 1 })
      expect(state.storage.get("held-send/ses_child")).toHaveProperty("wokenAt")
    })))

  test("once the host took the wake, the pool asks it nothing more for that hold: two restarts while it admits leave it", () =>
    onTestClock(Effect.gen(function* () {
      const until = 2 * MINUTE
      const state = heldWorld(until)
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      yield* refusalOf(plugin.request("ses_child"))
      yield* advance(until + MINUTE)
      expect(state.wakeAccess.calls).toBe(1)
      // A restart reads the rows at its start, while the pool admits the child; a second one again.
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* advance(5 * MINUTE)
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* advance(5 * MINUTE)
      expect(state.wakeAccess.calls).toBe(1)
      expect(admittedFor(state, "ses_child")).toHaveLength(1)
    })))

  // Every interleaving of failed deliveries, a reload, a stop and start, and a second server process on the same
  // store, between the decision, the host's admission and the mark: the host takes the wake exactly once.
  const DISRUPTIONS = ["none", "reload", "stop-start", "second-process"] as const
  const MOMENTS = ["before the host admits", "after the host admits, before the mark"] as const
  for (const disruption of DISRUPTIONS)
    test(`the host takes a held child's wake exactly once: failed deliveries, then ${disruption}, at each moment`, () =>
      onTestClock(Effect.gen(function* () {
        for (const fails of [0, 1, 2, 3])
          for (const moment of MOMENTS) {
            const label = `fails ${fails}, ${disruption}, ${moment}`
            const until = (yield* Clock.currentTimeMillis) + 2 * MINUTE
            const state = heldWorld(until)
            const sameProcess = LedgerLive.holdAuthority().lock
            const first = yield* Scope.make()
            const plugin = yield* start({ sweepMinutes: 0 }, state, live(), true, NO_ANTIGRAVITY, sameProcess).pipe(Scope.provide(first))
            const other = yield* Scope.make()
            if (disruption === "second-process") yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(other))
            yield* refusalOf(plugin.request("ses_child"))
            state.wakeAccess.fails = fails
            state.wakeAccess.hang = moment !== "before the host admits"
            // Past the hold and the failures' back-off (30 s, 1, 2 minutes): a delivery is made, or hangs at the host.
            yield* advance(until - (yield* Clock.currentTimeMillis) + 6 * MINUTE)
            const later = yield* Scope.make()
            if (disruption === "reload") {
              yield* start({ sweepMinutes: 0 }, state, live(), true, NO_ANTIGRAVITY, sameProcess).pipe(Scope.provide(later))
              yield* Scope.close(first, Exit.void)
            }
            if (disruption === "stop-start") {
              yield* Scope.close(first, Exit.void)
              yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(later))
            }
            state.wakeAccess.hang = false
            yield* advance(30 * MINUTE, 2 * MINUTE)
            expect([label, admittedFor(state, "ses_child").length]).toEqual([label, 1])
            expect([label, admittedFor(state, "ses_child")[0]?.id]).toEqual([label, HoldWake.wakeDeliveryId("ses_child", until)])
            yield* Scope.close(later, Exit.void)
            yield* Scope.close(other, Exit.void)
            yield* Scope.close(first, Exit.void)
          }
      })))

  test("two server processes on one store: both deliver the hold's one id, and the host takes it once", () =>
    onTestClock(Effect.gen(function* () {
      const until = 2 * MINUTE
      const state = heldWorld(until)
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* refusalOf(plugin.request("ses_child"))
      // The other process's mark is lost (overwritten by a stale write): the next look delivers the same id again.
      yield* advance(until + MINUTE)
      const row = state.storage.get("held-send/ses_child")
      expect(row).toHaveProperty("wokenAt")
      state.storage.set("held-send/ses_child", { sessionID: "ses_child", providerID: "anthropic", reasonCode: "account-held", retryAt: until, model: model.id })
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* advance(5 * MINUTE)
      expect(state.wakeAccess.calls).toBeGreaterThan(1)
      expect(admittedFor(state, "ses_child")).toHaveLength(1)
    })))

  test("with no held rows the wake scanner sets no timer; a written row is read when written and again when due", () =>
    onTestClock(Effect.gen(function* () {
      const state = world()
      state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      state.parents.set("ses_child", "ses_root")
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      yield* settle
      const atStart = state.wakeAccess.scans
      expect(atStart).toBeLessThanOrEqual(1)
      yield* TestClock.adjust(30 * 24 * HOUR)
      yield* settle
      expect(state.wakeAccess.scans).toBe(atStart)
      const now = yield* Clock.currentTimeMillis
      const until = now + 10 * MINUTE
      state.storage.set("anthropic/hold/cred-a", { kind: "rate-limit", at: now, until })
      yield* refusalOf(plugin.request("ses_child"))
      yield* advance(15 * MINUTE)
      expect(admittedFor(state, "ses_child")).toHaveLength(1)
      // Once when written, once when due: no look in between.
      expect(state.wakeAccess.scans - atStart).toBe(2)
    })))

  test("a wake scan with nothing due asks the pool nothing and claims no reset; at its time the re-check is the child's own question", () =>
    onTestClock(Effect.gen(function* () {
      const state = world()
      state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      state.parents.set("ses_child", "ses_root")
      // A spent 5-hour window with a grant in hand: a held request's admission would have the review claim it.
      state.readings.set("cred-a", {
        at: 0,
        windows: [
          { name: "5h", utilization: 1, resetAt: 3 * HOUR },
          { name: "7d", utilization: 0.4, resetAt: 72 * HOUR },
        ],
        resets: {
          available: 1,
          credits: [{ id: "grant-1", count: 2, usable: true, expiresAt: 120 * 24 * HOUR, clears: ["five_hour", "seven_day_overage_included"] }],
        },
      })
      const due = HOUR
      // A row as the pool wrote it before a restart: the child's own held request is not part of this start.
      state.storage.set("held-send/ses_child", { sessionID: "ses_child", providerID: "anthropic", reasonCode: "account-held", retryAt: due, model: model.id })
      const plugin = yield* start({ sweepMinutes: 0 }, state, live())
      const usage = state.holdAccess.usage
      yield* advance(due - MINUTE, 5 * MINUTE)
      expect(plugin.claims).toEqual([])
      expect(state.holdAccess.usage).toBe(usage)
      expect(state.synthetics).toEqual([])
      // Due: the pool is asked once, as the child's request would be at its dispatch; still held, the row takes the
      // pool's own time and nothing is woken. That question is the one bookkeeping a held request has (the newest
      // asker, the held work noted for the review); here the review claims nothing for it, and nothing is asked again
      // before the recheck.
      yield* advance(2 * MINUTE)
      expect(state.storage.get("held-send/ses_child")).toMatchObject({ retryAt: due, recheckAt: 3 * HOUR })
      const scans = state.wakeAccess.scans
      yield* advance(HOUR, 5 * MINUTE)
      expect(state.wakeAccess.scans).toBe(scans)
      expect(plugin.claims).toEqual([])
      expect(state.synthetics).toEqual([])
    })))

  test("rows the installed pool wrote (no model) are not woken; a row this pool wrote wakes once with an absent 5-hour window; gone sessions and hosts with a Step wake none", () =>
    onTestClock(Effect.gen(function* () {
      const state = world()
      state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      state.parents.set("ses_legacy", "ses_root")
      state.parents.set("ses_new", "ses_root")
      state.parents.set("ses_gone", "ses_root")
      state.missing.add("ses_gone")
      const until = MINUTE
      state.readings.set("cred-a", {
        at: until,
        usage: { at: until, samples: 1 },
        windows: [{ name: "7d", utilization: 0.1, resetAt: until + 72 * HOUR }],
        absent: [{ name: "5h", at: until }],
      })
      // Its parent got the old error, without "resumes by itself": it may have replaced the child by hand.
      state.storage.set("held-send/ses_legacy", { sessionID: "ses_legacy", providerID: "anthropic", reasonCode: "account-held", retryAt: until })
      state.storage.set("held-send/ses_new", { sessionID: "ses_new", providerID: "anthropic", reasonCode: "account-held", retryAt: until, model: model.id })
      state.storage.set("held-send/ses_gone", { sessionID: "ses_gone", providerID: "anthropic", reasonCode: "account-held", retryAt: until, model: model.id })
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* start({ sweepMinutes: 0 }, state, live())
      yield* advance(until + 30_000)
      expect(admittedFor(state, "ses_legacy")).toEqual([])
      expect(admittedFor(state, "ses_gone")).toEqual([])
      expect(state.synthetics).toHaveLength(1)
      expect(state.synthetics[0]).toMatchObject({
        sessionID: "ses_new",
        id: HoldWake.wakeDeliveryId("ses_new", until),
        text: HoldWake.WAKE_TEXT,
        woke: true,
      })
      // On a host with a Step (`experimental.model.resolve` with `step`), hold-wake does not wake or append the note.
      const stepped = world()
      stepped.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      stepped.parents.set("ses_stepped", "ses_root")
      stepped.storage.set("anthropic/hold/cred-a", { kind: "rate-limit", at: 0, until: (yield* Clock.currentTimeMillis) + MINUTE })
      const plugin = yield* start({ sweepMinutes: 0 }, stepped, live())
      const resolve = yield* registered(plugin.hooks, "experimental.model.resolve")
      yield* resolve({ sessionID: "ses_stepped", agent: "build", kind: "primary", model, step: { id: "step_1" } })
      expect(yield* refusalOf(plugin.request("ses_stepped"))).not.toContain(HoldWake.SUBAGENT_RESUME_NOTE)
      yield* advance(2 * MINUTE)
      expect(stepped.synthetics).toEqual([])
    })))
})

// The interim's three laws, each over its whole space: (1) what the parent was told of a held child stays true
// until the pool tells it otherwise; (2) the wake's re-check is the child's own question, and a pure one; (3) every
// row is found, whoever wrote it.
describe("interim hold-wake laws", () => {
  const advance = (ms: number, step = 30_000) =>
    Effect.gen(function* () {
      for (let left = ms; left > 0; left -= step) {
        yield* TestClock.adjust(Math.min(step, left))
        yield* settle
      }
    })
  const toSession = (state: World, sessionID: string) => state.synthetics.filter((entry) => entry.sessionID === sessionID)
  /** The stored held row for `sessionID`, `null` when there is none. */
  const heldRow = (state: World, sessionID = "ses_child") => Option.getOrNull(state.rows.get(`${HELD_PREFIX}${sessionID}`))
  /** The text of the one message the parent was told, `""` when it was told none. */
  const toldText = (state: World) => Option.getOrElse(Option.map(Arr.head(toSession(state, "ses_root")), (entry) => entry.text), () => "")
  const DecisionRow = Schema.Struct({ wokenAt: Schema.optional(Schema.Number), recheckAt: Schema.optional(Schema.Number) })
  const decodeDecision = Schema.decodeUnknownSync(DecisionRow)
  /** Whether the wake decided the row: it woke the child, or holds it to a re-check time. */
  const decided = (state: World) =>
    Option.isSome(Option.flatMap(Schema.decodeUnknownOption(DecisionRow)(heldRow(state)), (row) =>
      Option.orElse(Option.fromUndefinedOr(row.wokenAt), () => Option.fromUndefinedOr(row.recheckAt))))
  const heldWorld = (until: number, child = "ses_child") => {
    const state = world()
    state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
    state.parents.set(child, "ses_root")
    state.storage.set("anthropic/hold/cred-a", { kind: "rate-limit", at: 0, until })
    return state
  }

  // (1) Truth to the parent. The host is down (it answers neither `session.get` nor `session.synthetic`), cannot say
  // what a session is (`session.get` fails, a delivery would go), or refuses every delivery, for any time, and the pool restarts at any point: once the host is back, the child is woken once,
  // within the longest back-off and a minute.
  const OUTAGES = ["host down", "session lookups failing", "deliveries refused"] as const
  const RESTARTS = ["no restart", "a restart while down", "a restart after recovery"] as const
  const DURATIONS = [0, 45 * MINUTE, 6 * HOUR] as const
  for (const outage of OUTAGES)
    for (const restart of RESTARTS)
      test(`a held child is woken once after ${outage} for any time, with ${restart}; its parent hears nothing more`, () =>
        onTestClock(Effect.gen(function* () {
          for (const duration of DURATIONS) {
            const label = `${outage}, ${restart}, ${duration / MINUTE} min`
            const until = (yield* Clock.currentTimeMillis) + 2 * MINUTE
            const state = heldWorld(until)
            const first = yield* Scope.make()
            const plugin = yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(first))
            expect(yield* refusalOf(plugin.request("ses_child"))).toContain(HoldWake.SUBAGENT_RESUME_NOTE)
            if (duration > 0 && outage === "host down") state.wakeAccess.down = true
            if (duration > 0 && outage === "session lookups failing") state.wakeAccess.lookups = true
            if (duration > 0 && outage === "deliveries refused") state.wakeAccess.fails = 1_000_000
            yield* advance(until - (yield* Clock.currentTimeMillis) + duration, 5 * MINUTE)
            const later = yield* Scope.make()
            if (restart === "a restart while down") {
              yield* Scope.close(first, Exit.void)
              yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(later))
            }
            state.wakeAccess.down = false
            state.wakeAccess.lookups = false
            state.wakeAccess.fails = 0
            if (restart === "a restart after recovery") {
              yield* Scope.close(first, Exit.void)
              yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(later))
            }
            yield* advance(HoldWake.WAKE_RETRY_MAX_MS + MINUTE, MINUTE)
            expect([label, toSession(state, "ses_child").map((entry) => entry.id)]).toEqual([label, [HoldWake.wakeDeliveryId("ses_child", until)]])
            expect([label, toSession(state, "ses_root")]).toEqual([label, []])
            yield* Scope.close(later, Exit.void)
            yield* Scope.close(first, Exit.void)
          }
        })), hangGuard("in-memory"))

  // (1) When the pool stops for a reason it can know, it says so once: the child is gone, or its row cannot be read.
  for (const restart of RESTARTS)
    test(`a held child that is gone is never woken and its parent is told once, plainly, with ${restart}`, () =>
      onTestClock(Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + 2 * MINUTE
        const state = heldWorld(until)
        const first = yield* Scope.make()
        const plugin = yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(first))
        yield* refusalOf(plugin.request("ses_child"))
        state.missing.add("ses_child")
        state.wakeAccess.down = true
        yield* advance(until - (yield* Clock.currentTimeMillis) + 45 * MINUTE, 5 * MINUTE)
        const later = yield* Scope.make()
        if (restart === "a restart while down") {
          yield* Scope.close(first, Exit.void)
          yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(later))
        }
        state.wakeAccess.down = false
        if (restart === "a restart after recovery") {
          yield* Scope.close(first, Exit.void)
          yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(later))
        }
        yield* advance(HoldWake.WAKE_RETRY_MAX_MS + MINUTE, MINUTE)
        yield* start({ sweepMinutes: 0 }, state, live()).pipe(Scope.provide(later))
        yield* advance(HoldWake.WAKE_RETRY_MAX_MS + MINUTE, MINUTE)
        expect(toSession(state, "ses_child")).toEqual([])
        const told = toSession(state, "ses_root")
        expect(told).toHaveLength(1)
        expect(toldText(state)).toContain("ses_child")
        expect(toldText(state)).toContain("will not wake it")
        yield* Scope.close(later, Exit.void)
        yield* Scope.close(first, Exit.void)
      })), hangGuard("in-memory"))

  // A row this pool's kind wrote (it names a model, so the parent read "resumes by itself") whose time is damaged
  // is not dropped in silence: it is rebuilt once, whichever of two server processes reads it first, and the child is
  // woken once; a gone child's parent is told once.
  for (const child of ["alive", "gone"] as const)
    test(`a held row that no longer decodes is rebuilt and goes on: its ${child} child is woken once or its parent told once`, () =>
      onTestClock(Effect.gen(function* () {
        const state = heldWorld(0)
        state.storage.delete("anthropic/hold/cred-a")
        if (child === "gone") state.missing.add("ses_child")
        state.rows.set("held-send/ses_child", { providerID: "anthropic", reasonCode: "account-held", retryAt: "soon", model: model.id, parentID: "ses_root" })
        yield* start({ sweepMinutes: 0 }, state, live())
        yield* start({ sweepMinutes: 0 }, state, live())
        yield* advance(2 * MINUTE)
        yield* start({ sweepMinutes: 0 }, state, live())
        yield* advance(HoldWake.WAKE_RETRY_MAX_MS + MINUTE, MINUTE)
        const repaired = Schema.decodeUnknownSync(Schema.Struct({ sessionID: Schema.String, retryAt: Schema.Number }))(heldRow(state))
        expect(repaired.sessionID).toBe("ses_child")
        const woken = toSession(state, "ses_child").map((entry) => entry.id)
        const told = toSession(state, "ses_root")
        if (child === "alive") {
          expect(woken).toEqual([HoldWake.wakeDeliveryId("ses_child", repaired.retryAt)])
          expect(told).toEqual([])
        }
        if (child === "gone") {
          expect(woken).toEqual([])
          expect(told).toHaveLength(1)
          expect(toldText(state)).toContain("ses_child")
          expect(toldText(state)).toContain("will not wake it")
        }
      })), hangGuard("in-memory"))

  // (2) The re-check is the child's own question. For generated pool states, two identical worlds at one instant: in
  // W the wake re-checks a due row, in R the child's own request goes. Their answers agree (admitted, or held to the
  // same time), and the question changes nothing in W's decision stores (the reset review's waits, claims and spends,
  // the fleet, other held rows); with no evidence due (no usage read taken), nothing in the store at all.
  const DECISION_STORES = ["resets/", "fleet/", HELD_PREFIX] as const
  const snapshot = (state: World, keep: (key: string) => boolean) =>
    encodeJson(Arr.sort(
      [...state.storage.entries(), ...state.rows.keys(HELD_PREFIX).map((key): readonly [string, Schema.Json] => [key, Option.getOrNull(state.rows.get(key))])]
        .filter(([key]) => keep(key) && key !== "held-send/ses_child"),
      Order.mapInput(Order.String, ([key]: readonly [string, Schema.Json]) => key),
    ))
  test("the wake's re-check answers as the child's own request at the same instant, and records nothing", () =>
    onTestClock(Effect.gen(function* () {
      const random = generator("hold-wake-question")
      const seen = { admitted: 0, held: 0, evidence: 0, quiet: 0 }
      for (let index = 0; index < 16; index += 1) {
        const base = yield* Clock.currentTimeMillis
        const due = base + MINUTE
        const weekLeft = Option.getOrElse(Arr.get([72, 72, 30, 150] as const, below(random, 4)), () => 72) * HOUR
        const plain = {
          at: Option.getOrElse(Option.filter(Option.some(due - MINUTE), () => below(random, 4) > 0), () => base - 3 * HOUR),
          usage: { at: base, samples: 1 as const },
          windows: [
            { name: "5h", utilization: Option.getOrElse(Arr.get([0.1, 0.1, 0.6, 1] as const, below(random, 4)), () => 0.1), resetAt: base + (1 + below(random, 4)) * HOUR },
            { name: "7d", utilization: 0.45 + below(random, 40) / 100, resetAt: base + weekLeft },
          ],
        }
        const resets = { available: 1, credits: [{ id: "grant-1", count: 2, usable: true, expiresAt: base + 120 * 24 * HOUR, clears: ["five_hour", "seven_day_overage_included"] }] }
        // Half the readings carry a reset credit.
        const reading = Option.match(Option.liftPredicate(below(random, 2), (coin) => coin === 1), { onNone: () => plain, onSome: () => ({ ...plain, resets }) })
        const hold = below(random, 4)
        const label = `case ${index}: ${encodeJson(reading)} hold ${hold}`
        const make = () => {
          const state = world()
          state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
          state.parents.set("ses_child", "ses_root")
          state.readings.set("cred-a", reading)
          if (hold === 0) state.storage.set("anthropic/hold/cred-a", { kind: "rate-limit", at: base, until: due + 10 * MINUTE })
          return state
        }
        // W: the wake; R: the child's own request. Both pools run on one clock.
        const w = make()
        w.rows.set("held-send/ses_child", { sessionID: "ses_child", providerID: "anthropic", reasonCode: "even-line", retryAt: due, model: model.id, parentID: "ses_root" })
        const r = make()
        const scope = yield* Scope.make()
        const waker = yield* start({ sweepMinutes: 0 }, w, live()).pipe(Scope.provide(scope))
        const own = yield* start({ sweepMinutes: 0 }, r, live()).pipe(Scope.provide(scope))
        // Half the pools took the auth plugin's reading already, as it published it: with a fresh one the request has no
        // evidence to take.
        if (below(random, 2) === 0) {
          yield* waker.publish({ credentialID: "cred-a", reading })
          yield* own.publish({ credentialID: "cred-a", reading })
        }
        yield* settle
        const usageBefore = w.holdAccess.usage
        const ledger = snapshot(w, (key) => key.startsWith("anthropic/"))
        const everything = snapshot(w, () => true)
        const decisions = snapshot(w, (key) => DECISION_STORES.some((prefix) => key.startsWith(prefix)))
        yield* advance(due - (yield* Clock.currentTimeMillis), 15_000)
        yield* waitFor(`${label}: the wake's decision`, () => decided(w))
        // Evidence: a usage read, or a reading (and the hold it makes) the pool had not taken yet; the request takes both.
        const evidence = w.holdAccess.usage !== usageBefore || snapshot(w, (key) => key.startsWith("anthropic/")) !== ledger
        const row = decodeDecision(heldRow(w))
        const wake = Option.match(Option.fromUndefinedOr(row.wokenAt), { onSome: () => "admitted", onNone: () => `held to ${row.recheckAt}` })
        expect([label, snapshot(w, (key) => DECISION_STORES.some((prefix) => key.startsWith(prefix)))]).toEqual([label, decisions])
        if (!evidence) expect([label, snapshot(w, () => true)]).toEqual([label, everything])
        // R at the same instant.
        const sent = (yield* refusalOf(own.request("ses_child"))) === ""
        const ownRow = Schema.decodeUnknownOption(Schema.Struct({ retryAt: Schema.Number }))(heldRow(r))
        const asked = Option.match(Option.liftPredicate(sent, (admitted) => admitted), {
          onSome: () => "admitted",
          onNone: () => `held to ${Option.getOrUndefined(Option.map(ownRow, ({ retryAt }) => retryAt))}`,
        })
        expect([label, wake]).toEqual([label, asked])
        yield* Scope.close(scope, Exit.void)
        seen.admitted += Number(sent)
        seen.held += Number(!sent)
        seen.evidence += Number(evidence)
        seen.quiet += Number(!evidence)
        yield* TestClock.adjust(HOUR)
      }
      // The generated states reach both answers, with and without evidence due.
      expect([encodeJson(seen), Object.values(seen).every((count) => count > 0)]).toEqual([encodeJson(seen), true])
    })), hangGuard("in-memory"))

  test("an OpenAI-style row is asked its request's own gate (the known hold, then the send), never a pace its request is never asked", () =>
    onTestClock(Effect.gen(function* () {
      const base = yield* Clock.currentTimeMillis
      const due = base + MINUTE
      const make = () => {
        const state = world()
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
        state.active.set("anthropic", "cred-a")
        state.parents.set("ses_child", "ses_root")
        // Far over the spend-evenly line early in the week: the pace holds a new start; nothing holds a send.
        state.readings.set("cred-a", { at: base, usage: { at: base, samples: 1 }, windows: [
          { name: "5h", utilization: 0.2, resetAt: base + 3 * HOUR },
          { name: "7d", utilization: 0.95, resetAt: base + 150 * HOUR },
        ] })
        return state
      }
      const options = { paced: { sim: "anthropic" }, sweepMinutes: 0 }
      const w = make()
      w.rows.set("held-send/ses_child", { sessionID: "ses_child", providerID: "sim", reasonCode: "account-held", retryAt: due, model: model.id, parentID: "ses_root" })
      const r = make()
      yield* start(options, w, live())
      const own = yield* start(options, r, live())
      yield* advance(MINUTE)
      yield* waitFor("the OpenAI-style row's decision", () => decided(w))
      expect(toSession(w, "ses_child").map((entry) => entry.id)).toEqual([HoldWake.wakeDeliveryId("ses_child", due)])
      // The child's own request at the same instant passes its gate, the known hold and then the send.
      const event = { sessionID: "ses_child", agent: "build", kind: "primary", model: { ...model, providerID: "sim" }, headers: {} }
      expect(yield* refusalOf((yield* registered(own.hooks, "model.request"))(event))).toBe("")
      expect(yield* refusalOf((yield* registered(own.hooks, "http.request"))(event))).toBe("")
      // The pace would hold a new start: that is the question the wake must not ask.
      expect(yield* own.pace("sim", "ses_other")).toMatchObject({ ok: false })
    })), hangGuard("in-memory"))

  // (3) Every row is found. Another server process on the same store (a SQLite file, as OpenCode's KV) writes a held
  // row and stops for good or keeps running, before or after this process started: this process wakes it within one
  // sweep of its time. With no rows anywhere, the wake adds no look of its own to the sweep's.
  const WRITER = [
    'import { Database } from "bun:sqlite"',
    "const [file, key, value, stay] = process.argv.slice(2)",
    "const db = new Database(file, { create: true })",
    'db.run("create table if not exists kv (key text primary key, value text not null)")',
    'db.run("insert or replace into kv (key, value) values (?, ?)", [key, value])',
    "db.close()",
    'console.log("written")',
    'if (stay === "stay") setInterval(() => {}, 1 << 30)',
  ].join("\n")
  const WRITERS = ["before this process started, then stopped", "after it started, then stopped for good", "after it started, still running"] as const
  test("a held row another server process wrote is found within one sweep, whether that process stopped or still runs", () =>
    onTestClock(Effect.gen(function* () {
      const dir = yield* scratchRoot
      const script = join(dir, "writer.ts")
      writeFileSync(script, WRITER)
      for (const writer of WRITERS) {
        const file = join(dir, `${writers(writer)}.db`)
        const rows = sqliteRows(file)
        yield* Effect.addFinalizer(() => Effect.sync(() => rows.close()))
        const state = world()
        state.rows = rows
        state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
        state.parents.set("ses_other", "ses_root")
        const due = (yield* Clock.currentTimeMillis) + 2 * MINUTE
        const row = encodeJson({ sessionID: "ses_other", providerID: "anthropic", reasonCode: "account-held", retryAt: due, model: model.id, parentID: "ses_root" })
        const scope = yield* Scope.make()
        // A separate bun process in its own group, ended with this case's scope if it still runs.
        const write = (mode: "exit" | "stay") =>
          Effect.gen(function* () {
            const processes = yield* ChildProcessSpawner.ChildProcessSpawner
            const child = yield* processes.spawn(ChildProcess.make("bun", [script, file, "held-send/ses_other", row, mode], { detached: true, stdin: "ignore", stderr: "inherit", forceKillAfter: "1 second" }))
            yield* Stream.decodeText(child.stdout).pipe(Stream.takeUntil((text) => text.includes("written")), Stream.runDrain)
          }).pipe(Effect.provide(BunServices.layer), Scope.provide(scope))
        if (writer === WRITERS[0]) yield* write("exit")
        yield* start({ sweepMinutes: 10 }, state, live()).pipe(Scope.provide(scope))
        yield* advance(MINUTE)
        if (writer === WRITERS[1]) yield* write("exit")
        if (writer === WRITERS[2]) yield* write("stay")
        yield* advance(due - (yield* Clock.currentTimeMillis) + 10 * MINUTE + MINUTE, MINUTE)
        expect([writer, toSession(state, "ses_other").map((entry) => entry.id)]).toEqual([writer, [HoldWake.wakeDeliveryId("ses_other", due)]])
        yield* Scope.close(scope, Exit.void)
      }
    }).pipe(Effect.scoped)), hangGuard("process-fixture"))

  test("with no held rows anywhere, the sweep's own look at the rows is the only one", () =>
    onTestClock(Effect.gen(function* () {
      const state = world()
      state.integration.connections.set(ANTHROPIC, [CONNECTIONS[0]])
      yield* start({ sweepMinutes: 10 }, state, live())
      yield* advance(2 * MINUTE, MINUTE)
      const scans = state.wakeAccess.scans
      yield* advance(10 * HOUR, 10 * MINUTE)
      // One look per sweep (the held-send cleanup's), 60 sweeps in 10 hours: nothing of the wake's own.
      expect(state.wakeAccess.scans - scans).toBe(60)
    })), hangGuard("in-memory"))
})

const writers = (writer: string) => writer.replace(/[^a-z]+/g, "-")
