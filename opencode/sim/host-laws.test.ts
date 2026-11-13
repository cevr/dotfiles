// The host laws on the world, at every seed: the law probe (sim/server.ts)
// loaded into the world runs each law from inside it, as tests/host-laws.test.ts
// runs it in real OpenCode. And no operation the world's context offers stands
// without a law: every one of them is named by one.
import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect } from "bun:test"
import { Array as Arr, Effect, Predicate, Schema } from "effect"
import { OPERATIONS } from "./context.ts"
import { ClientAsk, LAWS } from "./host-laws.ts"
import * as Provider from "./provider.ts"
import * as Seed from "./seed.ts"
import { answer, BROKEN, CLIENT, DONE, KEPT, LAW_FOLDER, LAW_LOGIN, LAW_SOCKET, NAMES, outcome, PROBE_OPTIONS } from "./law-names.ts"
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

/**
 * The law model over HTTP, as real OpenCode's scripted model answers (tests/host-laws/real.ts): a turn offers tools,
 * a compaction asks for the summary, a title is the rest; each answered as law-names.ts `answer` says.
 */
const lawModel = ({ body }: Provider.RequestInfo): Provider.Answer => {
  const text = textsOf(body["messages"] ?? []).join("\n")
  const tools = body["tools"]
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
      // The socket law's model streams over a WebSocket, as real OpenCode's OpenAI Responses provider does.
      models: [World.SIM_MODEL, { ...LAW_SOCKET, modelID: LAW_SOCKET.id, limit: { context: 128_000 }, cost: [], settings: { transport: "websocket" } }],
      anthropic: { accounts: {}, anonymous: true, script: lawModel },
      integrations: { anthropic: [{ ...LAW_LOGIN, expires: World.START + 8 * 3_600_000 }] },
    })
    yield* world.load(Probe, { directory: `/scratch/${LAW_FOLDER}`, options: PROBE_OPTIONS })
    // What the probe asks of the host's client, the world's driver does, as the real run's SDK does.
    const asks = () => world.logs().flatMap((line) => Arr.filter([line.message.slice(CLIENT.length)], () => line.message.startsWith(CLIENT)))
    const done = () => world.logs().some((line) => line.message === DONE)
    for (let handled = 0; !done(); ) {
      yield* world.until(() => done() || asks().length > handled, 20 * 60_000, 500)
      for (const json of asks().slice(handled)) {
        handled += 1
        yield* act(world, yield* decodeAsk(json))
      }
    }
    return world.logs().flatMap(lawLine)
  })

const decodeAsk = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientAsk))

/** Does a law's ask of the client with the world's own driver. */
const act = (world: World.World, ask: ClientAsk) => {
  if (ask.action === "archive") return world.archive(ask.sessionID)
  return world.reply(ask.sessionID, { [ask.key]: ask.value })
}

/** A law's outcome line, alone; nothing for another. */
const lawLine = (line: { readonly message: string }) => {
  if (line.message.startsWith(KEPT) || line.message.startsWith(BROKEN)) return [line.message]
  return []
}

describe("the host laws on the world", () => {
  for (const law of LAWS)
    seeded(law.name, ({ seed, expect: check }) =>
      Effect.gen(function* () {
        const lines = yield* lawsOn(seed)
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
