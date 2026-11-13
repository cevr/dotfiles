// The client laws (client-laws.ts) on the server double, and their reach:
// every route the double serves and every event kind it may send is named by
// a law; a law naming a route or kind the double does not have is refused too.
// tests/client-laws.test.ts runs the same laws on real OpenCode. Its tests run
// on effect-test.ts: sim-tui resolves the fork's Effect, whose types are not
// effect-bun-test's.
import { describe, expect } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { effectTest } from "./effect-test.ts"
import { type Answer, type Call, KINDS, LAWS, type LawServer, LawServerError, ROUTES, type Sent } from "./client-laws.ts"
import * as Server from "./server.ts"

/** A law on the double takes a few milliseconds. */
const TIMEOUT_MS = 5_000
const BRIEF = "Worker brief."
const Json = Schema.fromJsonString(Schema.Unknown)
const toJson = Schema.encodeSync(Json)

/** The laws' scripted model, as client-laws.ts's header says. */
const model: Server.Model = ({ text: prompt, step }) => {
  if (prompt.includes(BRIEF)) return [Server.reasoning("Looking."), Server.stall].filter(() => step === 0)
  if (step > 0) return []
  if (prompt.includes("stall")) return [Server.text("Working on it"), Server.stall]
  if (prompt.includes("spawn"))
    return [
      Server.subagent({
        id: "call_worker",
        input: { description: "Check the parser", prompt: BRIEF, background: true },
        title: "Check the parser",
        agent: "worker",
        model: Server.MODEL_REF,
      }),
    ]
  return [Server.text("Done.")]
}

/** A request the double reads as the TUI's: its body as JSON, when it has one. */
const requestOf = ({ method, path, body }: Call) =>
  new Request(
    `http://localhost${path}`,
    Option.match(body, {
      onNone: () => ({ method }),
      onSome: (value) => ({ method, body: toJson(value), headers: { "content-type": "application/json" } }),
    }),
  )

/** The double as a law server, on a clock that moves 1 ms a call. */
const double = (): LawServer => {
  const clock = { now: 1_793_804_400_000 }
  const server = Server.make({ draw: () => 0, now: () => clock.now, model })
  const sent: Array<Sent> = []
  const drain = Effect.sync(() => void sent.push(...server.take()))
  const call = (made: Call) =>
    Effect.gen(function* () {
      clock.now += 1
      const request = requestOf(made)
      const answered = yield* Effect.tryPromise({
        try: () => server.fetch(new URL(request.url), request),
        catch: (cause) => new LawServerError({ message: `${made.method} ${made.path} threw`, cause }),
      })
      yield* drain
      if (Option.isNone(answered)) return { status: 599, body: Option.some(`the double left ${made.method} ${made.path} to the fixture`) }
      const text = yield* Effect.promise(() => answered.value.text())
      return { status: answered.value.status, body: Option.flatMap(Option.liftPredicate(text, (value) => value !== ""), Schema.decodeUnknownOption(Json)) }
    })
  return {
    // As a bare session.create makes one: no agent or model of its own.
    session: Effect.sync(() => server.session({ own: false })),
    call: (made): Effect.Effect<Answer, LawServerError> => call(made),
    sent: Effect.as(drain, sent),
    settle: Effect.andThen(Effect.all([Effect.yieldNow, Effect.yieldNow, Effect.yieldNow]), drain),
    model: Server.MODEL_REF,
  }
}

describe("the client laws on the double", () => {
  for (const law of LAWS)
    effectTest(
      law.name,
      Effect.gen(function* () {
        expect(yield* law.run(double())).toEqual([])
      }),
      TIMEOUT_MS,
    )
})

describe("every route and event kind of the double is named by a law", () => {
  effectTest("each served route", Effect.sync(() => expect(Server.SERVED.filter((route) => !ROUTES.has(route))).toEqual([])), TIMEOUT_MS)
  effectTest("each event kind", Effect.sync(() => expect(Server.EVENTS.filter((kind) => !KINDS.has(kind))).toEqual([])), TIMEOUT_MS)
  effectTest(
    "a law names only what the double has",
    Effect.sync(() => {
      const served = new Set<string>(Server.SERVED)
      const kinds = new Set<string>(Server.EVENTS)
      expect([...ROUTES].filter((route) => !served.has(route))).toEqual([])
      expect([...KINDS].filter((kind) => !kinds.has(kind))).toEqual([])
    }),
    TIMEOUT_MS,
  )
})
