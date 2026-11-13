// The simulated OpenCode host for server plugins. It runs our real
// composition roots (`cmd/<mod>/server.ts`) together, each one built from its
// plugin definition on a plugin context the world gives it (context.ts), on
// the host's rules (host.ts) and the runtime (runtime.ts): one seed, a virtual
// clock, memory alone.
//
// What the host does is what the stand-in hosts in `cmd/*/server.test.ts`
// did, made into one host; each behaviour is held to real OpenCode by a law in
// host-laws.ts. Every operation here is an Effect that runs the world to rest
// at this instant (`advance` and `until` move the clock), and fails with a
// SimError when the world cannot: a plugin reached for something unmodelled, a
// run waits outside the world, or the world does not settle.
//
// A run's trace holds every host event, hook, model request, tool call and
// answer, steer, store write and log line, each at its virtual time. It holds
// no wall-clock value, so two runs on one seed give byte-equal traces.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Exit, Option, Scope, type Schema } from "effect"
import { contextFor, isContext, type Loaded } from "./context.ts"
import { type Asked, type Message, makeHost, type ModelRef, type Session, type Options, type Process, START } from "./host.ts"
import * as Provider from "./provider.ts"
import { type JsonObject, type LogLine, makeRuntime, Owner, SimError } from "./runtime.ts"

export {
  call,
  PROCESSES,
  type Asked,
  type CatalogModel,
  type Kind,
  type Message,
  type ModelRef,
  type Options,
  type Process,
  type Reply,
  type Request,
  type Script,
  say,
  SIM_MODEL,
  START,
  USAGE,
  type Usage,
} from "./host.ts"
export { SimError } from "./runtime.ts"

/** The model a world with Anthropic in it runs its sessions on, as the real files configure it. */
export const ANTHROPIC_MODEL = { providerID: "anthropic", id: "claude-haiku-4-5" }
/** Where the host sends Anthropic's requests before a hook moves them, as the fork's catalog names it. */
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"

interface Instance {
  readonly loaded: Loaded
  readonly scope: Scope.Closeable
  readonly number: number
}

export interface WorldOptions extends Options {
  /** Anthropic as part of the world (sim/provider.ts): sessions run on `anthropic/claude-haiku-4-5` and their requests go to it over HTTP. */
  readonly anthropic?: Omit<Provider.Options, "seed">
}

export const make = (worldOptions: WorldOptions) => {
  const start = worldOptions.start ?? START
  const logs: Array<LogLine & { readonly at: number }> = []
  /** Timers that fired for a copy already closed: none, unless a restart leaks one. */
  const stale: Array<number> = []
  const instances: Array<Instance> = []
  const loads: Array<Loaded> = []
  const runtime = makeRuntime({
    seed: worldOptions.seed,
    start,
    log: (entry) => {
      logs.push({ ...entry, at: runtime.now() })
      host.record("log", entry)
    },
    fired: (owner) => {
      if (owner === 0 || instances.some((instance) => instance.number === owner)) return
      stale.push(owner)
      host.record("stale-timer", { owner })
    },
  })
  const provider = Option.map(Option.fromNullishOr(worldOptions.anthropic), (anthropic) => Provider.make({ ...anthropic, seed: worldOptions.seed }, runtime))
  const options: Options = Option.match(provider, {
    onNone: () => worldOptions,
    onSome: (served) => {
      const model = worldOptions.model ?? ANTHROPIC_MODEL
      // A provider on an API key is configured at the world's origin; Anthropic's logins reach it through the auth plugin's hook.
      const baseURL = Option.match(Option.liftPredicate(`${Provider.ORIGIN}/v1`, () => worldOptions.anthropic?.anonymous === true), {
        onNone: () => ANTHROPIC_BASE_URL,
        onSome: (origin) => origin,
      })
      return { ...worldOptions, model, provider: { id: model.providerID, baseURL, handle: served.handle } }
    },
  })
  const host = makeHost(options, runtime, start)
  const counter = { instances: 0 }

  /** Runs `effect` in the world to rest; fails when a plugin reached for something the world does not model. */
  const run = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | SimError> => runtime.run(effect).pipe(Effect.tap(() => unmodelled))

  const unmodelled = Effect.suspend(() => {
    const reached = host.unmodelled.splice(0)
    if (reached.length === 0) return Effect.void
    return Effect.fail(new SimError({ message: `a plugin reached for what the world does not model: ${reached.join(", ")}` }))
  })

  /** Starts one copy of a plugin on its context, its fibers marked as its own. */
  const startOne = (loaded: Loaded) =>
    Effect.gen(function* () {
      counter.instances += 1
      const number = counter.instances
      const scope = yield* Scope.make()
      instances.push({ loaded, scope, number })
      host.record("plugin-loading", { id: loaded.plugin.id, directory: loaded.directory })
      logs.push({ level: "Info", message: "loading plugin", annotations: { id: loaded.plugin.id, directory: loaded.directory }, at: runtime.now() })
      const context = contextFor(host, loaded, number, loaded.plugin.id)
      if (!isContext(context)) return yield* Effect.die(new Error("sim: the world's context lacks an operation it lists in OPERATIONS"))
      yield* loaded.plugin.effect(context).pipe(Scope.provide(scope), Effect.provideService(Owner, number))
    })

  const closeAll = Effect.gen(function* () {
    for (const instance of instances.splice(0)) {
      host.record("plugin-closing", { id: instance.loaded.plugin.id, directory: instance.loaded.directory })
      host.directories.delete(instance.number)
      yield* Scope.close(instance.scope, Exit.void)
    }
  })

  const startAll = Effect.forEach(loads, (loaded) => run(startOne(loaded)), { discard: true })

  const sessionOf = (sessionID: string): Effect.Effect<Session, SimError> =>
    Option.match(Option.fromNullishOr(host.sessions.get(sessionID)), {
      onNone: () => Effect.fail(new SimError({ message: `no session ${sessionID}` })),
      onSome: Effect.succeed,
    })

  /** Advances in steps of `step` until `done` holds; fails past `limit` ms of virtual time. */
  const until = (done: () => boolean, limit: number, step = 100) =>
    Effect.gen(function* () {
      const from = runtime.now()
      while (!done()) {
        if (runtime.now() - from >= limit) return yield* Effect.fail(new SimError({ message: `not done within ${limit} ms of virtual time` }))
        yield* runtime.advance(step)
        yield* unmodelled
      }
      return runtime.now() - from
    })

  return {
    start,
    runtime,
    /** The world's Anthropic: what it received, each account's tokens. Fails a world made without one. */
    provider: () => Option.getOrThrowWith(provider, () => new SimError({ message: "this world has no provider: make it with `anthropic`" })),
    sessions: host.sessions,
    storage: host.storage,
    record: host.record,
    /** The trace so far, one JSON line per record. */
    trace: () => host.trace.join("\n"),
    /** Every model request with the conversation it carried, at its virtual time (ms since the start). */
    asked: (): ReadonlyArray<Asked> => host.asked,
    /** The model requests in order: when, which session, which kind. */
    requests: () => host.asked.map(({ at, sessionID, kind }) => ({ at, sessionID, kind })),
    logs: (): ReadonlyArray<LogLine & { readonly at: number }> => logs,
    now: () => runtime.now(),
    elapsed: () => runtime.now() - start,
    /** The copies closed whose timers fired after: a restart that leaks the old scope. */
    stale: (): ReadonlyArray<number> => stale,
    /** The live copies' numbers. */
    live: () => instances.map((instance) => instance.number),
    /** The owners of the timers still set. */
    timers: () => runtime.timers(),
    isUp: () => host.state.up,
    /** What a command prints in the world's shell at `now`. */
    processes: (command: string, now: number): Process => host.processes(command, now),
    /** The session's context, as `session.context` answers it, before the views. */
    context: (sessionID: string): ReadonlyArray<Message> =>
      Option.match(Option.fromNullishOr(host.sessions.get(sessionID)), { onNone: () => [], onSome: host.contextOf }),
    /** Every message the session holds, before its newest compaction too. */
    messages: (sessionID: string): ReadonlyArray<Message> => host.sessions.get(sessionID)?.messages ?? [],
    /** Loads a plugin for a directory, as OpenCode does for each location it serves, and starts it. */
    load: (plugin: Plugin.Plugin, input: { readonly directory: string; readonly options?: JsonObject }) =>
      Effect.suspend(() => {
        const loaded = { plugin, directory: input.directory, options: input.options ?? {} }
        loads.push(loaded)
        return run(startOne(loaded))
      }),
    /** Every copy closed and built again from its plugin, on the same storage and sessions: a reload. */
    restart: Effect.suspend(() => {
      host.record("restart", {})
      return run(closeAll).pipe(Effect.andThen(startAll))
    }),
    /** The server stops: every copy closes, executions and shells stop, nothing runs until `up`. */
    down: Effect.suspend(() => {
      host.record("down", {})
      return run(closeAll).pipe(Effect.andThen(Effect.sync(host.stop)), Effect.andThen(runtime.settle))
    }),
    /** The server starts again on the same stores and sessions; each plugin is built again, then idle sessions with work start. */
    up: Effect.suspend(() => {
      host.record("up", {})
      return startAll.pipe(Effect.andThen(run(Effect.sync(host.resume))))
    }),
    /** A new root session in `directory` (on an agent and a model, as the owner may pick them): its id. */
    session: (directory: string, input: { readonly id?: string; readonly parentID?: string; readonly agent?: string; readonly model?: ModelRef } = {}) =>
      run(host.createSession({ directory, ...input })).pipe(Effect.map((session) => session.id)),
    /** The owner sends `text` to the session: a prompt, which wakes it. */
    prompt: (sessionID: string, text: string) =>
      sessionOf(sessionID).pipe(Effect.flatMap((session) => run(host.admit(session, { id: host.mint("msg_"), type: "prompt", text, resume: true })))),
    /** The session is deleted. */
    remove: (sessionID: string) =>
      run(
        Effect.suspend(() => {
          if (!host.sessions.delete(sessionID)) return Effect.void
          return host.publish({ type: "session.deleted", data: { sessionID } })
        }),
      ),
    /** Calls an RPC method as a client of the host (the TUI, another plugin) would. */
    rpc: (id: string, method: string, input: Schema.Json) => run(host.callRpc(id, method, input)),
    /** Calls a tool as a session's model would, outside a turn: its answer. */
    tool: (sessionID: string, name: string, input: Schema.Json) =>
      sessionOf(sessionID).pipe(Effect.flatMap((session) => run(host.runTool(session, host.mint("msg_"), { id: host.mint("call_"), name, input })))),
    /** Moves virtual time on by `ms`, every timer due on the way firing at its instant. */
    advance: (ms: number) => runtime.advance(ms).pipe(Effect.andThen(unmodelled)),
    until,
  }
}

export type World = ReturnType<typeof make>
