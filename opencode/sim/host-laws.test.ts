// The host laws on the world, at every seed: the law probe (sim/server.ts)
// loaded into the world runs each law from inside it, as tests/host-laws.test.ts
// runs it in real OpenCode. And no operation the world's context offers stands
// without a law: every one of them is named by one.
import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect } from "bun:test"
import { Array as Arr, Effect, Option, Predicate, Schema } from "effect"
import { OPERATIONS } from "./context.ts"
import { LAWS } from "./host-laws.ts"
import * as Provider from "./provider.ts"
import { plain } from "./runtime.ts"
import * as Seed from "./seed.ts"
import { answer, BROKEN, callOf, DONE, KEPT, LAW_FOLDER, LAW_LOGIN, LAW_SOL, NAMES, outcome, PROBE_OPTIONS } from "./law-names.ts"
import Probe from "./server.ts"
import * as World from "./world.ts"

const { seeded } = Seed.runner("sim/host-laws.test.ts")

/** The fields of a messages body that hold its texts. */
const TEXTS = new Set(["text", "content", "messages"])

/** A request's texts, in order, from the body the host sent. */
const textsOf = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value]
  if (Predicate.isNumber(value) || Predicate.isBoolean(value) || Predicate.isNull(value)) return []
  if (Array.isArray(value)) return value.flatMap(textsOf)
  return Object.entries(value).flatMap(([key, inner]) => Arr.filter([inner], () => TEXTS.has(key)).flatMap(textsOf))
}

/** The last text of a request's last message: a law's `law-call:` prompt, or what a tool answered. */
const lastText = (messages: Schema.Json) => {
  if (!Array.isArray(messages)) return Option.none<string>()
  return Option.flatMap(Arr.last(messages), (message) => Arr.last(textsOf(message)))
}

/**
 * The law model over HTTP, as real OpenCode's scripted model answers (tests/host-laws/real.ts): a turn offers tools,
 * a compaction asks for the summary, a title is the rest; each answered as law-names.ts `answer` says.
 */
/** A law call's input, as law-names.ts `callOf` gives its text: a JSON object. */
const CallInput = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const lawModel = ({ body }: Provider.RequestInfo): Provider.Answer => {
  const messages = body["messages"] ?? []
  // The system prompt comes first, as real OpenCode's scripted model reads its system message first.
  const text = [...textsOf(body["system"] ?? []), ...textsOf(messages)].join("\n")
  const tools = body["tools"]
  const asked = Option.flatMap(lastText(messages), (said) =>
    Option.flatMap(Arr.head(callOf(said)), (call) => Option.map(Schema.decodeUnknownOption(CallInput)(call.input), (input) => ({ name: call.name, input }))),
  )
  if (Array.isArray(tools) && tools.length > 0 && Option.isSome(asked)) return { kind: "ok", tool: { name: asked.value.name, input: plain(asked.value.input) } }
  if (Array.isArray(tools) && tools.length > 0) return { kind: "ok", text: answer("primary", text) }
  if (text.includes("summarize the conversation above")) return { kind: "ok", text: answer("compaction", text) }
  return { kind: "ok", text: answer("title", text) }
}

/** One world on `seed` with the probe loaded for the law folder, run until it has run every law: its log. */
const lawsOn = (seed: number) =>
  Effect.gen(function* () {
    // The model goes over HTTP, as on real OpenCode, so the HTTP and retry laws have a wire to hook; the integration law a login.
    const world = World.make({
      seed,
      schedules: true,
      script: (request) => World.say(answer(request.kind, request.text)),
      model: { providerID: "sim", id: "sim-model" },
      // As real OpenCode's law config: the sim model, and a sol of a family with a release date.
      models: [World.SIM_MODEL, { ...World.SIM_MODEL, id: LAW_SOL.id, modelID: LAW_SOL.id, family: LAW_SOL.family, time: { released: Date.parse(LAW_SOL.releaseDate) } }],
      anthropic: { accounts: {}, anonymous: true, script: lawModel },
      integrations: { anthropic: [{ ...LAW_LOGIN, expires: World.START + 8 * 3_600_000 }] },
    })
    yield* world.load(Probe, { directory: `/scratch/${LAW_FOLDER}`, options: PROBE_OPTIONS })
    yield* world.until(() => world.logs().some((line) => line.message === DONE), 20 * 60_000, 500)
    return world.logs().flatMap(lawLine)
  })

/** A law's outcome line, alone; nothing for another. */
const lawLine = (line: { readonly message: string }) => {
  if (line.message.startsWith(KEPT) || line.message.startsWith(BROKEN)) return [line.message]
  return []
}

describe("the host laws on the world", () => {
  // One world per seed runs every law; each law's test reads its own line of that run, as the real run's tests do.
  const runs = new Map<number, ReadonlyArray<string>>()
  const linesOn = (seed: number) =>
    Option.match(Option.fromNullishOr(runs.get(seed)), {
      onSome: Effect.succeed,
      onNone: () => lawsOn(seed).pipe(Effect.tap((lines) => Effect.sync(() => void runs.set(seed, lines)))),
    })
  for (const law of LAWS)
    seeded(law.name, ({ seed, expect: check }) =>
      Effect.gen(function* () {
        const lines = yield* linesOn(seed)
        check(outcome(lines, law.name)).toEqual([`${KEPT}${law.name}`])
      }),
    )

  Seed.effect(
    "the real run names the same laws, in the same order",
    Effect.sync(() => expect(LAWS.map((law) => law.name)).toEqual([...NAMES])),
  )

  Seed.effect(
    "every operation the world's context offers is named by a law, and the context offers nothing else",
    Effect.gen(function* () {
      const named = new Set(LAWS.flatMap((law) => law.operations))
      expect(OPERATIONS.filter((operation) => !named.has(operation))).toEqual([])
      const offered: Array<string> = []
      const world = World.make({ seed: 1, script: () => World.say("") })
      const walker: Plugin.Plugin = {
        id: "dotfiles-opencode.sim-walker",
        effect: (ctx) => Effect.sync(() => void offered.push(...operationsOf(ctx))),
      }
      yield* world.load(walker, { directory: "/scratch/walk" })
      expect(offered.toSorted()).toEqual([...OPERATIONS].toSorted())
    }),
  )
})

/** The paths of what a context offers: its data, its domains' operations, and an operation that is itself a domain (`rpc`). */
const operationsOf = (ctx: Plugin.Context) =>
  Object.entries(ctx).flatMap(([key, value]): ReadonlyArray<string> => {
    if (key === "options" || key === "location") return [key]
    const inner = Object.keys(value).map((name) => `${key}.${name}`)
    if (Predicate.isFunction(value)) return [key, ...inner]
    return inner
  })
