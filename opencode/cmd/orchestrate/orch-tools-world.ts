// The `orchestrate` tool's runs on the simulated host (sim/world.ts): the real orchestrate plugin (sim/plugins.ts
// `orchestrate`), the real rift plugin (cmd/rift/server.ts `make`) on the rift mod's memory layers and the real status
// plugin (sim/plugins.ts `status`, in the units' location), one copy of the others per location, over one memory world of warm sources, Rifts and
// unit logs. The units' logs are the world's files: the orchestrate plugin writes a unit's moves there, as log.ts does,
// and the status script prints them as its table, as status.ts does on disk. Each root turn is one `probe:` call; a
// subagent's task that ends `handback: <line>` answers that line. orch-tools.sim.test.ts drives it.
import { Array as Arr, Effect, Layer, Option, Order, Schema } from "effect"
import type { Asked } from "@dotfiles/opencode-orchestrate/memory/fleet"
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
/** The run the units' logs are in: `<WORK>/tmp/orchestrate/<RUN>/<unit>/log.md`. */
export const RUN = "lane"
const RUNS = `${WORK}/tmp/orchestrate`
export const RUN_DIR = `${RUNS}/${RUN}`
/** Where the status plugin finds the orchestrate skill's status script. */
const STATUS_SCRIPT = "/skills/orchestrate/scripts/status.ts"
/** When every log line was written: the pinned clock's minute. */
const SINCE = "2026-11-04T15:00Z"

const ProbeCall = Schema.fromJsonString(Schema.Struct({ name: Schema.String, input: Schema.Record(Schema.String, Schema.Json) }))
const decodeProbe = Schema.decodeUnknownOption(ProbeCall)
const encodeProbe = Schema.encodeSync(ProbeCall)

/** A call's input, as a probe sends it. */
export type Input = { readonly [key: string]: Schema.Json }

/** A unit's log as the world keeps it: the state its last move went to, and that move's round. */
export interface UnitLog {
  readonly state: string
  readonly round: number
}

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

/** The status script's table for the logs, as status.ts prints it: one row per unit, by name. */
export const tableOf = (logs: ReadonlyMap<string, UnitLog>): string =>
  [
    "| Unit | State | Round | Since | Cause |",
    "| --- | --- | --- | --- | --- |",
    ...[...logs].toSorted(([a], [b]) => Order.String(a, b)).map(([unit, log]) => `| ${unit} | ${log.state} | ${log.round} | ${SINCE} | log.md |`),
    "",
  ].join("\n")

/** How the world boots: its clock and the models its host offers, and a root's model. */
export interface BootOptions {
  readonly now?: string
  readonly models?: ReadonlyArray<World.CatalogModel>
}

/** The rift plugin's copies and the orchestrate plugin's, loaded in each of the world's locations (`orchestrate` off: the rift plugin alone). */
export const boot = Effect.fn("OrchTools.boot")(function* (seed: number, orchestrate: boolean, options: BootOptions = {}) {
  const woken: Array<MemoryNotices.Woken> = []
  // The units' logs: written by the orchestrate plugin, as log.ts writes log.md; read by the status script.
  const logs = new Map<string, UnitLog>()
  const fleet: Array<Asked> = []
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
    // A subagent: the hand-back line of its task.
    const task = Option.getOrElse(Option.map(Arr.findFirst(world.messages(request.sessionID), (message) => message.type === "user"), said), () => "")
    const handBack = Arr.findFirst(task.split("\n"), (line) => Option.liftPredicate(line.trim(), (trimmed) => trimmed.startsWith(HAND_BACK)))
    return Option.match(handBack, {
      onNone: () => World.say("sim: nothing to do"),
      onSome: (line) => World.say(`${line.slice(HAND_BACK.length).trim()}\nThe gate is green.`),
    })
  }
  /** The run's folder and the status script over it, in the world's shell. */
  const processes = (command: string): World.Process => {
    // No run folder until a unit has a log: `ls` fails, as on a repository with none.
    if (command === `ls -1 ${RUNS}` && logs.size === 0) return { exitCode: 1, stdout: "", ms: 5 }
    if (command === `ls -1 ${RUNS}`) return { exitCode: 0, stdout: `${RUN}\n`, ms: 5 }
    if (command === `bun ${STATUS_SCRIPT} ${RUN_DIR}`) return { exitCode: 0, stdout: tableOf(logs), ms: 50 }
    return World.PROCESSES(command)
  }
  const made = { seed, start: Date.parse(options.now ?? PIN), script, processes }
  const world = World.make(Option.match(Option.fromUndefinedOr(options.models), { onNone: () => made, onSome: (models) => ({ ...made, models }) }))
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
  const plugin = Plugins.orchestrate({
    fleet,
    unitLogs: {
      find: ({ unit }) => Effect.succeed(`${RUN_DIR}/${unit}`),
      append: (dir, transition) => Effect.sync(() => void logs.set(dir.split("/").at(-1) ?? transition.unit, { state: transition.to, round: transition.round })),
    },
  })
  for (const directory of [WORK, PLAIN]) {
    if (orchestrate) yield* world.load(plugin, { directory, options: { now: options.now ?? PIN, fleet: { dotfiles: "/scratch/dotfiles", fork: "/scratch/fork" } } })
    yield* world.load(rift, { directory, options: { workrift: false } })
  }
  // The status plugin in the units' location only: the simulated host keeps one RPC per id, the last copy registered,
  // and the status RPC answers the runs of its own copy's location.
  yield* world.load(Plugins.status(world), { directory: WORK, options: { statusScript: STATUS_SCRIPT } })
  const idle = (sessionID: string) => Option.exists(Option.fromUndefinedOr(world.sessions.get(sessionID)), (session) => !session.running && session.inbox.length === 0)
  /** Every session of the world is idle: no turn runs and none waits. */
  const settled = () => [...world.sessions.keys()].every(idle)
  /** One probe turn: the session makes that one call; its answer's text. */
  const probe = Effect.fn("OrchTools.probe")(function* (sessionID: string, name: string, input: Input) {
    const from = world.messages(sessionID).length
    yield* world.prompt(sessionID, `${PROBE}${encodeProbe({ name, input })}`)
    yield* world.until(() => idle(sessionID), 120_000)
    return answerAfter(world.messages(sessionID), from)
  })
  /** The children of a session, in the order made. */
  const children = (parent: string) => [...world.sessions.values()].filter((session) => Option.contains(session.parentID, parent))
  return { world, offered, logs, fleet, memory, woken, probe, idle, settled, children }
})

export type Run = Effect.Success<ReturnType<typeof boot>>
