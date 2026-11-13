// The batch machine's runs on the simulated host (sim/world.ts), as
// tests/orchestrate/run.ts ran them on real OpenCode: the orchestrate plugin
// (sim/plugins.ts `orchestrate`) with its ledger in memory, a fixture `rift`
// tool that only records each land, and tests/orchestrate/sim.ts's scripted
// model on the world's requests. orchestrate-machine.sim.test.ts drives its
// scenarios through it.
import { Plugin } from "@opencode/plugin/effect"
import { Array as Arr, Deferred, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as World from "../../sim/world.ts"

export const WORK = "/scratch/work"
export const OTHER = "/scratch/other"
/** The plugin's fixed clock: a Wednesday afternoon. */
export const PIN = "2026-11-04T15:00:00Z"

/** A task whose last line is `handback: <line>` answers with that line first. */
export const HAND_BACK = "handback:"
/** A root turn that makes one given call: `probe:` and `{ name, input }` as JSON. */
export const PROBE = "probe:"
export const MACHINE_TASK = "machine-run"
/** The machine run's summary: the root's context after its compaction. */
export const MACHINE_SUMMARY = "## Objective\n- machine-run summary: three implementors handed back ready"
/** The input tokens the reply that starts the third implementor reports: past the root's 400k window, so it compacts. */
export const MACHINE_FULL = 500_000
/** The machine run root's last words, once its batch's verifier has handed back. */
export const MACHINE_DONE = "root: batch-1 landed and verified"
/** What the subagent call answers as the child starts in the background. */
const BACKGROUND = "The subagent is working in the background"

/** The sim provider's model, as the real runs' config offers it: a window as large as Opus's, four efforts. */
const SIM_MODEL: World.CatalogModel = {
  providerID: "sim",
  id: "sim-model",
  modelID: "sim-model",
  limit: { context: 1_000_000 },
  cost: [],
  variants: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
}

/** A call the machine run's root makes, by its tool and input. */
interface Step {
  readonly name: string
  readonly input: { readonly [key: string]: Schema.Json }
}

const implementor = (unit: string, gate = ""): Step => ({
  name: "subagent",
  input: { agent: "implementor", description: `implementor ${unit} r1`, prompt: `${gate}${HAND_BACK} implementor ${unit} r1: ready /run/${unit}/round-1-request.md` },
})

/** The gate gamma's implementor waits on: it still runs as the root compacts, until the test opens it. */
export const GAMMA = "gamma"

/**
 * What the machine run's root was last told, and what it does next (tests/orchestrate/sim.ts `MACHINE_SCRIPT`): keyed
 * on the newest message that says one of these lines, in this order, never on a count of tool results, which the
 * compaction removes.
 */
const MACHINE_SCRIPT: ReadonlyArray<readonly [string, Step | string]> = [
  ["verifier batch-1 r1: accepted", MACHINE_DONE],
  ["Landed 3 Rift(s)", { name: "subagent", input: { agent: "verifier", description: "verifier batch-1 r1", prompt: `${HAND_BACK} verifier batch-1 r1: accepted /run/batch-1-findings.md` } }],
  ["Land every ready unit at once when the cadence fires", { name: "rift", input: { action: "land", rifts: ["alpha", "beta", "gamma"] } }],
  ["One verifier per batch, fresh", { name: "rift", input: { action: "land", rifts: ["alpha"] } }],
  // Compacted while gamma still runs in the background: the root waits for its report.
  [MACHINE_SUMMARY, "root: waiting for gamma"],
  ["implementor gamma r1: ready", { name: "subagent", input: { agent: "verifier", description: "verifier alpha r1", prompt: `${HAND_BACK} verifier alpha r1: accepted /run/alpha/round-1-findings.md` } }],
  ["implementor beta r1: ready", implementor("gamma", `gate:${GAMMA}\n`)],
  ["implementor alpha r1: ready", implementor("beta")],
  [MACHINE_TASK, implementor("alpha")],
]

/** A message's text as the model reads it: a call's assistant message says nothing. */
const said = (message: World.Message): string => {
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

/** The machine run's next step: by the newest message that says one of the script's lines, in the script's order. */
const machineStep = (messages: ReadonlyArray<World.Message>) =>
  Arr.findFirst(messages.toReversed(), (message) => Arr.findFirst(MACHINE_SCRIPT, ([line]) => said(message).includes(line)))

const lastLine = (text: string) =>
  Option.getOrElse(
    Arr.last(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
    () => "",
  )

const ProbeCall = Schema.fromJsonString(Schema.Struct({ name: Schema.String, input: Schema.Record(Schema.String, Schema.Json) }))

/** One line of the machine's ledger, as the test reads it: what it names, of the fields the tests look at. */
export const LedgerLine = Schema.Struct({
  kind: Schema.String,
  sessionID: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  units: Schema.optional(Schema.Array(Schema.String)),
  batch: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.String),
  findings: Schema.optional(Schema.Array(Schema.String)),
  finding: Schema.optional(Schema.String),
  into: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  child: Schema.optional(Schema.String),
  ready: Schema.optional(Schema.Boolean),
  unresolved: Schema.optional(Schema.Struct({ report: Schema.String, why: Schema.String })),
})
export type LedgerLine = typeof LedgerLine.Type
const decodeLine = Schema.decodeUnknownOption(LedgerLine)

const LandInput = Schema.Struct({ action: Schema.String, rifts: Schema.optional(Schema.Array(Schema.String)), departs: Schema.optional(Schema.String) })

/** The fixture `rift` tool: it records each land's Rifts and answers as a pushed land does. */
const rift = (lands: Array<ReadonlyArray<string>>) =>
  Plugin.define({
    id: "fixture.rift",
    effect: (ctx) =>
      ctx.tool.transform((editor) =>
        editor.add({
          name: "rift",
          description: 'Lands Rifts as one batch: rift({ action: "land", rifts: [...] }).',
          options: { codemode: false },
          input: LandInput,
          execute: (input) =>
            Effect.sync(() => {
              const rifts = input.rifts ?? []
              lands.push(rifts)
              return { content: `Landed ${rifts.length} Rift(s) as one push: ${rifts.join(", ")}.`, metadata: { action: "land" } }
            }),
        }),
      ),
  })

/**
 * One world with the orchestrate plugin and the fixture rift tool loaded for each of `directories` (one copy per
 * location, over one ledger), the scripted model, and what the run reads back.
 */
export const boot = (seed: number, directories: ReadonlyArray<string> = [WORK]) =>
  Effect.gen(function* () {
    const ledger: Array<unknown> = []
    const lands: Array<ReadonlyArray<string>> = []
    const files = new Map<string, string>()
    const gates = new Map<string, Deferred.Deferred<void>>()
    const gate = (name: string) => {
      const found = gates.get(name) ?? Deferred.makeUnsafe<void>()
      gates.set(name, found)
      return found
    }
    const machine = { root: "" }
    const calls = { count: 0 }
    const call = (step: Step, input = 100) => {
      calls.count += 1
      return World.call(`call_${calls.count}`, step.name, step.input, { input, read: 0, write: 0 })
    }
    const sayOf = (text: string) => World.say(text, { input: 100, read: 0, write: 0 })
    /** The machine run's root's request: its step, full on the one that starts gamma until it has compacted. */
    const machineRoot = (messages: ReadonlyArray<World.Message>) => {
      const last = messages.at(-1)
      if (last?.type === "tool" && last.output.includes(BACKGROUND)) return sayOf("root: waiting for the subagent")
      const step = machineStep(messages)
      const compacted = messages.some((message) => message.type === "compaction")
      const full = Option.exists(step, ([line]) => line === "implementor beta r1: ready") && !compacted
      return Option.match(step, {
        onNone: () => sayOf("root: lost the machine script"),
        onSome: ([, next]) => {
          if (Schema.is(Schema.String)(next)) return sayOf(next)
          return call(next, Option.getOrElse(Option.liftPredicate(MACHINE_FULL, () => full), () => 100))
        },
      })
    }
    // tests/orchestrate/sim.ts's model, on the world's sessions.
    const script: World.Script = (request) => {
      if (request.kind === "title") return sayOf("Orchestrate run")
      if (request.kind === "compaction") return sayOf(Option.getOrElse(Option.liftPredicate(MACHINE_SUMMARY, () => request.sessionID === machine.root), () => "## Objective\n- sim summary"))
      const messages = world.context(request.sessionID)
      const first = Option.fromUndefinedOr(world.messages(request.sessionID).find((message) => message.type === "user"))
      const task = Option.getOrElse(Option.map(first, said), () => "")
      // A probe turn: the root makes that one call, then says it is done.
      const probed = messages.findLastIndex((message) => message.type === "user" && message.text.startsWith(PROBE))
      if (probed >= 0) {
        if (messages.slice(probed + 1).some((message) => message.type === "tool")) return sayOf("probe done")
        const asked = Schema.decodeUnknownSync(ProbeCall)(said(messages[probed] ?? messages[0]!).slice(PROBE.length))
        return call(asked)
      }
      if (request.sessionID === machine.root) return machineRoot(messages)
      // A hand-back line anywhere in the task; a gated task's first request answers once its gate opens.
      const handBack = Arr.findFirst(task.split("\n"), (line) => Option.liftPredicate(line.trim(), (trimmed) => trimmed.startsWith(HAND_BACK)))
      const answer = Option.match(handBack, {
        onNone: () => sayOf(`sim: ${lastLine(said(messages.at(-1) ?? messages[0]!)) || "nothing"}`),
        onSome: (line) => sayOf(`${line.slice(HAND_BACK.length).trim()}\nThe gate is green.`),
      })
      const gated = Option.fromNullishOr(/^gate:(\S+)$/m.exec(task)?.[1])
      return Option.match(Option.filter(gated, () => messages.length === 1), {
        onNone: () => answer,
        onSome: (name) => Deferred.await(gate(name)).pipe(Effect.as(answer)),
      })
    }
    const world = World.make({ seed, start: Date.parse(PIN), script, models: [SIM_MODEL], model: { providerID: "sim", id: "sim-model" } })
    const plugin = Plugins.orchestrate({ ledger, files })
    for (const directory of directories) {
      yield* world.load(plugin, { directory, options: { now: PIN } })
      yield* world.load(rift(lands), { directory })
    }
    const idle = (sessionID: string) => Option.exists(Option.fromUndefinedOr(world.sessions.get(sessionID)), (session) => !session.running && session.inbox.length === 0)
    /** One turn of the session: the prompt, then until it is at rest. */
    const turn = (sessionID: string, text: string) => world.prompt(sessionID, text).pipe(Effect.andThen(world.until(() => idle(sessionID), 120_000)))
    /** One probe turn: the root makes that call. */
    const probe = (sessionID: string, name: string, input: { readonly [key: string]: Schema.Json }) => turn(sessionID, `${PROBE}${Schema.encodeSync(ProbeCall)({ name, input })}`)
    /** The ledger's lines, of one root or every one. */
    const lines = (sessionID?: string) =>
      ledger.flatMap((line) => Option.toArray(decodeLine(line))).filter((line) => Option.match(Option.fromUndefinedOr(sessionID), { onNone: () => true, onSome: (id) => line.sessionID === id }))
    /** Until the root's ledger holds a line that matches. */
    const has = (sessionID: string, match: (line: LedgerLine) => boolean) => world.until(() => lines(sessionID).some(match), 20_000)
    /** How many times a root's unit has handed back. */
    const handedBack = (sessionID: string, unit: string) => lines(sessionID).filter((line) => line.kind === "UnitHandedBack" && line.unit === unit).length
    /** A gated task's first request answers. */
    const open = (name: string) => Deferred.succeed(gate(name), void 0)
    /** The children of a session, in the order made. */
    const children = (parent: string) => [...world.sessions.values()].filter((session) => Option.contains(session.parentID, parent))
    return { world, lands, files, machine, turn, probe, lines, has, handedBack, open, idle, children, said }
  })

export type Run = Effect.Success<ReturnType<typeof boot>>
