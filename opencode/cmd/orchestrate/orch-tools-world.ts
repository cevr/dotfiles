// The `orchestrate` tool's runs on the simulated host (sim/world.ts): the real orchestrate plugin (sim/plugins.ts
// `orchestrate`, its ledger in memory) and the real rift plugin (cmd/rift/server.ts `make`) on the rift mod's memory
// layers, one copy of each per location, over one memory world of warm sources and Rifts. Each root turn is one
// `probe:` call; a subagent's task that ends `handback: <line>` answers that line. orch-tools.sim.test.ts drives it.
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import * as MemoryDebts from "@dotfiles/opencode-rift/memory/debts"
import * as MemoryLanding from "@dotfiles/opencode-rift/memory/landing"
import * as MemoryNotices from "@dotfiles/opencode-rift/memory/notices"
import * as MemoryRifts from "@dotfiles/opencode-rift/memory/rifts"
import * as MemoryWorkbox from "@dotfiles/opencode-rift/memory/workbox"
import { SessionDirectories, SessionUnreadable } from "@dotfiles/opencode-rift/service"
import * as Plugins from "../../sim/plugins.ts"
import * as World from "../../sim/world.ts"
import { make as makeRift } from "../rift/server.ts"

/** The warm source the run's roots work in. */
export const WORK = "/scratch/work"
/** A second warm source, of sessions that run no units. */
export const PLAIN = "/scratch/plain"
/** The plugin's fixed clock: a Wednesday afternoon. */
export const PIN = "2026-11-04T15:00:00Z"
/** A task whose last line is `handback: <line>` answers with that line first. */
export const HAND_BACK = "handback:"
/** A root turn that makes one given call: `probe:` and `{ name, input }` as JSON. */
export const PROBE = "probe:"
/** The commit origin's default branch names as the push left it: the memory landing's head of its last push. */
export const ORIGIN = "origin/HEAD"

/** One line of the machine's ledger, of the fields the tests read. */
export const LedgerLine = Schema.Struct({
  kind: Schema.String,
  sessionID: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  units: Schema.optional(Schema.Array(Schema.String)),
  batch: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.String),
  departs: Schema.optional(Schema.String),
  ready: Schema.optional(Schema.Boolean),
})
export type LedgerLine = typeof LedgerLine.Type
const decodeLine = Schema.decodeUnknownOption(LedgerLine)

const ProbeCall = Schema.fromJsonString(Schema.Struct({ name: Schema.String, input: Schema.Record(Schema.String, Schema.Json) }))
const decodeProbe = Schema.decodeUnknownOption(ProbeCall)
const encodeProbe = Schema.encodeSync(ProbeCall)

/** A call's input, as a probe sends it. */
export type Input = { readonly [key: string]: Schema.Json }

/** A message's text as the model reads it. */
export const said = (message: World.Message): string => {
  switch (message.type) {
    case "user":
    case "synthetic":
    case "assistant":
      return message.text
    case "tool":
      return message.output
    case "compaction":
      return message.summary
    case "error":
      return message.message
  }
}

/** The memory world under every rift plugin copy: the two warm sources, their Rifts, the landing, the debts. */
const riftWorldOf = () => {
  const landing = MemoryLanding.world({
    [WORK]: MemoryLanding.config("main", "bun run gate", "bun run accept"),
    [PLAIN]: MemoryLanding.config("main", "bun run gate", "bun run accept"),
  })
  const base = MemoryRifts.world([WORK, PLAIN])
  // `origin/HEAD` reads as the last push's commit, as `git rev-parse` reads it after a land; any other commit is itself.
  const rifts: MemoryRifts.World = {
    ...base,
    commitOf: (at) =>
      Option.some(
        Option.getOrElse(
          Option.map(Option.liftPredicate(at, (commit) => commit === ORIGIN), () => landing.headOf(landing.pushes)),
          () => at,
        ),
      ),
  }
  return { rifts, landing, debts: MemoryDebts.world() }
}

/** A tool's answer: its text, and whether it failed (a refusal, or the tool's own failure). */
export interface Answer {
  readonly text: string
  readonly error: boolean
}

/** A session's last tool answer after its message at `from`. */
const answerAfter = (messages: ReadonlyArray<World.Message>, from: number): Answer =>
  Option.getOrElse(
    Arr.findFirst(messages.slice(from).toReversed(), (message) =>
      Option.liftPredicate(message, (found) => found.type === "tool").pipe(Option.map((found): Answer => ({ text: said(found), error: found.type === "tool" && found.error }))),
    ),
    (): Answer => ({ text: "", error: true }),
  )

/** The rift plugin's copies and the orchestrate plugin's, loaded in each of the world's locations (`orchestrate` off: the rift plugin alone). */
export const boot = Effect.fn("OrchTools.boot")(function* (seed: number, orchestrate: boolean) {
  const ledger: Array<Schema.Json> = []
  const woken: Array<MemoryNotices.Woken> = []
  // The files a verifier's report and its unit findings are read from, by absolute path.
  const files = new Map<string, string>()
  const memory = riftWorldOf()
  const calls = { count: 0 }
  /** The tool names the last request offered, as the registry listed them. */
  const offered: Array<string> = []
  const script: World.Script = (request) => {
    if (request.kind === "title") return World.say("Orchestrate run")
    offered.splice(0, offered.length, ...request.tools)
    if (request.kind === "compaction") return World.say("## Objective\n- sim summary")
    const messages = world.context(request.sessionID)
    const probed = messages.findLastIndex((message) => message.type === "user" && message.text.startsWith(PROBE))
    const asked = Option.flatMap(Option.liftPredicate(probed, (index) => index >= 0), (index) =>
      Option.flatMap(Arr.get(messages, index), (message) => decodeProbe(said(message).slice(PROBE.length))),
    )
    if (Option.isSome(asked)) {
      if (messages.slice(probed + 1).some((message) => message.type === "tool")) return World.say("probe done")
      calls.count += 1
      return World.call(`call_${calls.count}`, asked.value.name, asked.value.input)
    }
    // A subagent: the hand-back line of its task, once.
    const task = Option.getOrElse(Option.map(Arr.findFirst(world.messages(request.sessionID), (message) => message.type === "user"), said), () => "")
    const handBack = Arr.findFirst(task.split("\n"), (line) => Option.liftPredicate(line.trim(), (trimmed) => trimmed.startsWith(HAND_BACK)))
    return Option.match(handBack, {
      onNone: () => World.say("sim: nothing to do"),
      onSome: (line) => World.say(`${line.slice(HAND_BACK.length).trim()}\nThe gate is green.`),
    })
  }
  const world = World.make({ seed, start: Date.parse(PIN), script })
  // A session's location, as OpenCode's `session.get` reports it.
  const directories = Layer.succeed(
    SessionDirectories,
    SessionDirectories.of({
      directoryOf: Effect.fn("OrchTools.directoryOf")(function* (sessionID: string) {
        const session = Option.fromUndefinedOr(world.sessions.get(sessionID))
        if (Option.isNone(session)) return yield* new SessionUnreadable({ sessionID, message: `no session ${sessionID}` })
        return session.value.directory
      }),
    }),
  )
  const rift = makeRift(() =>
    Layer.mergeAll(
      MemoryRifts.layer(memory.rifts),
      directories,
      MemoryLanding.layer(memory.landing),
      MemoryNotices.layer(woken),
      MemoryWorkbox.layer(false),
      MemoryDebts.layer(memory.debts),
    ),
  )
  const plugin = Plugins.orchestrate({ ledger, files })
  for (const directory of [WORK, PLAIN]) {
    if (orchestrate) yield* world.load(plugin, { directory, options: { now: PIN } })
    yield* world.load(rift, { directory, options: { workrift: false } })
  }
  const idle = (sessionID: string) => Option.exists(Option.fromUndefinedOr(world.sessions.get(sessionID)), (session) => !session.running && session.inbox.length === 0)
  /** One probe turn: the session makes that one call; its answer's text. */
  const probe = Effect.fn("OrchTools.probe")(function* (sessionID: string, name: string, input: Input) {
    const from = world.messages(sessionID).length
    yield* world.prompt(sessionID, `${PROBE}${encodeProbe({ name, input })}`)
    yield* world.until(() => idle(sessionID), 120_000)
    return answerAfter(world.messages(sessionID), from)
  })
  /** The ledger's lines of one root. */
  const lines = (sessionID: string) => ledger.flatMap((line) => Option.toArray(decodeLine(line))).filter((line) => line.sessionID === sessionID)
  /** The ledger's lines of one root as written, for the drift score. */
  const written = (sessionID: string) => ledger.filter((line) => Option.exists(decodeLine(line), (decoded) => decoded.sessionID === sessionID))
  /** Until the root's ledger holds a line that matches. */
  const has = (sessionID: string, match: (line: LedgerLine) => boolean) => world.until(() => lines(sessionID).some(match), 30_000)
  /** The children of a session, in the order made. */
  const children = (parent: string) => [...world.sessions.values()].filter((session) => Option.contains(session.parentID, parent))
  return { world, offered, ledger, files, memory, woken, probe, lines, written, has, idle, children }
})

export type Run = Effect.Success<ReturnType<typeof boot>>
