import { describe, expect, test } from "bun:test"
import { heavyChildrenIn } from "./heavy-agents.ts"

const NOW = "2026-11-13T16:00:00.000Z"
const SINCE = "2026-11-13T04:00:00.000Z"
const BEFORE = "2026-11-13T03:59:59.999Z"
const lines = (...each: ReadonlyArray<string>) => each.join("\n")

describe("heavyChildrenIn", () => {
  test("names each implementor's and verifier's child, from its line or its call's done line, once; not a planner's or a worker's", () => {
    const text = lines(
      `{"kind":"call","at":"${NOW}","sessionID":"rootA","callID":"c1","from":"build","agent":"implementor","reason":"kept"}`,
      `{"kind":"call","at":"${NOW}","sessionID":"rootA","callID":"c2","from":"build","agent":"planner","reason":"kept"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"rootA","callID":"c2","child":"plan","status":"running"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"rootA","callID":"c1","child":"impl","status":"running"}`,
      `{"kind":"call","at":"${NOW}","sessionID":"rootB","callID":"c1","from":"build","agent":"verifier","reason":"kept","child":"check"}`,
      `{"kind":"call","at":"${NOW}","sessionID":"rootB","callID":"c3","from":"build","agent":"worker","reason":"general"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"rootB","callID":"c3","child":"work","status":"running"}`,
      // A follow-up of the same implementor names it again; it counts once.
      `{"kind":"call","at":"${NOW}","sessionID":"rootA","callID":"c4","from":"build","agent":"implementor","reason":"kept","child":"impl"}`,
      "not json",
      `{"kind":`,
    )
    expect(heavyChildrenIn(text, SINCE)).toEqual(["impl", "check"])
  })

  test("a kernel cell's calls share one id: each heavy start takes the next done line of its call", () => {
    const text = lines(
      `{"kind":"call","at":"${NOW}","sessionID":"root","callID":"cell","from":"build","agent":"implementor","reason":"kept"}`,
      `{"kind":"call","at":"${NOW}","sessionID":"root","callID":"cell","from":"build","agent":"verifier","reason":"kept"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"root","callID":"cell","child":"one","status":"running"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"root","callID":"cell","child":"two","status":"running"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"root","callID":"cell","child":"three","status":"running"}`,
    )
    expect(heavyChildrenIn(text, SINCE)).toEqual(["one", "two"])
  })

  test("reads no start before its window, no done line of a call it did not count, and no latch until it opens", () => {
    const text = lines(
      `{"kind":"call","at":"${BEFORE}","sessionID":"root","callID":"old","from":"build","agent":"implementor","reason":"kept"}`,
      `{"kind":"done","at":"${NOW}","sessionID":"root","callID":"old","child":"stale","status":"running"}`,
      `{"kind":"latched","at":"${NOW}","sessionID":"root","callID":"held","from":"build","agent":"implementor","reason":"kept","child":"waiting"}`,
      `{"kind":"call","at":"${SINCE}","sessionID":"root","callID":"edge","from":"build","agent":"verifier","reason":"kept","child":"edge"}`,
    )
    expect(heavyChildrenIn(text, SINCE)).toEqual(["edge"])
  })
})
