import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { arming, INTERVAL_MS, isSigned, limitsOf, MAX_PINGS, nextPing, pingBody, pingHeaders, SHORT_CACHE_MS, usageOf } from "./keepalive.ts"

// Bun test bridge: no Effect test runner is installed, so a case runs its effect with Effect.runSync.
const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("arming", () => {
  const facts = { ttlMs: SHORT_CACHE_MS, signed: true, body: Option.some("{}"), child: Effect.succeed(true) }

  test("a subagent's signed request on the five-minute cache arms it", () => {
    expect(run(arming(facts))).toBe("armed")
  })

  test("a root's, an hour's cache, an unsigned or unpingable request does not; the session is read only when the rest allows", () => {
    let asked = 0
    const child = Effect.sync(() => {
      asked++
      return false
    })
    expect(run(arming({ ...facts, child }))).toBe("root")
    expect(run(arming({ ...facts, child, ttlMs: 3_600_000 }))).toBe("long-cache")
    expect(run(arming({ ...facts, child, signed: false }))).toBe("unsigned")
    expect(run(arming({ ...facts, child, body: Option.none() }))).toBe("unpingable")
    expect(asked).toBe(1)
  })
})

describe("pingBody", () => {
  test("the request's body with max_tokens 1, nothing else changed", () => {
    const body = { model: "m", max_tokens: 32_000, stream: true, thinking: { type: "adaptive", display: "omitted" }, system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "x" }] }
    expect(parsed(Option.getOrThrow(pingBody(json(body))))).toEqual({ ...body, max_tokens: 1 })
  })

  test("none for a body that is no messages request, or thinks on a budget", () => {
    expect(Option.isNone(pingBody("not json"))).toBe(true)
    expect(Option.isNone(pingBody(json({ prompt: "x" })))).toBe(true)
    expect(Option.isNone(pingBody(json({ messages: [], thinking: { type: "enabled", budget_tokens: 2_048 } })))).toBe(true)
  })
})

describe("nextPing", () => {
  test("due 4.5 minutes after the request or ping before; at once when that has passed but the cache lives", () => {
    expect(nextPing(0, SHORT_CACHE_MS, 60_000, 0)).toEqual(Option.some(INTERVAL_MS - 60_000))
    expect(nextPing(0, SHORT_CACHE_MS, INTERVAL_MS + 10_000, 0)).toEqual(Option.some(0))
  })

  test("none once the cache has expired, or the wait sent its 4", () => {
    expect(Option.isNone(nextPing(0, SHORT_CACHE_MS, SHORT_CACHE_MS, 0))).toBe(true)
    expect(Option.isNone(nextPing(0, SHORT_CACHE_MS, 0, MAX_PINGS))).toBe(true)
  })
})

describe("a ping's answer and headers", () => {
  test("the usage of a stream and of a JSON message", () => {
    const stream = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":90000,"cache_creation_input_tokens":12,"output_tokens":1}}}',
      'data: {"type":"content_block_delta"}',
      "data: not json",
      'data: {"type":"message_delta","usage":{"output_tokens":1}}',
    ].join("\n")
    expect(usageOf(stream)).toEqual({ input: 3, read: 90_000, write: 12, output: 1 })
    expect(usageOf(json({ usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1 } }))).toEqual({ input: 5, read: 7, write: 0, output: 1 })
    expect(usageOf("")).toEqual({ input: 0, read: 0, write: 0, output: 0 })
  })

  test("the rate-limit headers, by lower-case name", () => {
    expect(limitsOf([["Anthropic-Ratelimit-Unified-Status", "allowed"], ["request-id", "r"]])).toEqual({ "anthropic-ratelimit-unified-status": "allowed" })
  })

  test("a ping copies every header but the length and host; a request carries its login when it has an authorization", () => {
    const headers = [["authorization", "Bearer t"], ["Content-Length", "9"], ["host", "h"], ["anthropic-beta", "b"]] as const
    expect(pingHeaders(headers)).toEqual([["authorization", "Bearer t"], ["anthropic-beta", "b"]])
    expect(isSigned(headers)).toBe(true)
    expect(isSigned([["x-api-key", "k"]])).toBe(true)
    expect(isSigned([["content-type", "application/json"], ["authorization", " "]])).toBe(false)
  })
})
