// The client laws (client-laws.ts) on the server double, and their reach:
// every route the double serves and every event kind it may send is named by
// a law; a law naming a route or kind the double does not have is refused too.
import { describe, expect, test } from "bun:test"
import { KINDS, LAWS, type LawServer, ROUTES, type Sent } from "./client-laws.ts"
import * as Server from "./server.ts"

const BRIEF = "Worker brief."

/** The laws' scripted model, as client-laws.ts's header says. */
const model: Server.Model = ({ text, step }) => {
  if (text.includes(BRIEF)) return step === 0 ? [{ _tag: "Reasoning", text: "Looking." }, { _tag: "Stall" }] : undefined
  if (step > 0) return undefined
  if (text.includes("stall")) return [{ _tag: "Text", text: "Working on it" }, { _tag: "Stall" }]
  if (text.includes("spawn"))
    return [
      {
        _tag: "Subagent",
        id: "call_worker",
        input: { description: "Check the parser", prompt: BRIEF, background: true },
        title: "Check the parser",
        agent: "worker",
        model: Server.MODEL_REF,
      },
    ]
  return [{ _tag: "Text", text: "Done." }]
}

/** The double as a law server, on a clock that moves 1 ms a call. */
const double = (): LawServer => {
  const clock = { now: 1_793_804_400_000 }
  const server = Server.make({ draw: () => 0, now: () => clock.now, model })
  const sent: Array<Sent> = []
  const drain = () => {
    for (const event of server.take()) sent.push(event as unknown as Sent)
  }
  return {
    session: async () => server.session(),
    call: async (method, path, body) => {
      clock.now += 1
      const request = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) })
      const answer = await server.fetch(new URL(request.url), request)
      drain()
      if (answer === undefined) return { status: 599, body: `the double left ${method} ${path} to the fixture` }
      const text = await answer.text()
      return { status: answer.status, body: text === "" ? undefined : JSON.parse(text) }
    },
    sent: () => {
      drain()
      return sent
    },
    settle: async () => {
      for (let turn = 0; turn < 3; turn++) await Promise.resolve()
      drain()
    },
  }
}

describe("the client laws on the double", () => {
  for (const law of LAWS)
    test(law.name, async () => {
      expect(await law.run(double())).toEqual([])
    })
})

describe("every route and event kind of the double is named by a law", () => {
  test("each served route", () => {
    expect(Server.SERVED.filter((route) => !ROUTES.has(route))).toEqual([])
  })
  test("each event kind", () => {
    expect(Server.EVENTS.filter((kind) => !KINDS.has(kind))).toEqual([])
  })
  test("a law names only what the double has", () => {
    const served = new Set<string>(Server.SERVED)
    const kinds = new Set<string>(Server.EVENTS)
    expect([...ROUTES].filter((route) => !served.has(route))).toEqual([])
    expect([...KINDS].filter((kind) => !kinds.has(kind))).toEqual([])
  })
})
