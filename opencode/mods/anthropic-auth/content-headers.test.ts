import { describe, expect, test } from "bun:test"
import { contentLength, headersAfterBodyTransform, isJsonMediaType } from "./content-headers.ts"

describe("contentLength", () => {
  test("accepts safe decimal lengths only", () => {
    expect(contentLength(new Headers({ "content-length": "42" }))).toBe(42)
    expect(contentLength(new Headers({ "content-length": "-1" }))).toBeUndefined()
    expect(contentLength(new Headers({ "content-length": "1.5" }))).toBeUndefined()
    expect(contentLength(new Headers())).toBeUndefined()
  })
})

describe("headersAfterBodyTransform", () => {
  test("drops the headers a rewritten body would make false and keeps the rest", () => {
    const headers = headersAfterBodyTransform(
      new Headers({ "content-length": "10", etag: "x", digest: "d", "content-type": "application/json" }),
    )
    expect(headers.has("content-length")).toBe(false)
    expect(headers.has("etag")).toBe(false)
    expect(headers.has("digest")).toBe(false)
    expect(headers.get("content-type")).toBe("application/json")
  })
})

describe("isJsonMediaType", () => {
  test("reads application/json and +json types, ignoring parameters and case", () => {
    expect(isJsonMediaType(new Headers({ "content-type": "Application/JSON; charset=utf-8" }))).toBe(true)
    expect(isJsonMediaType(new Headers({ "content-type": "application/problem+json" }))).toBe(true)
    expect(isJsonMediaType(new Headers({ "content-type": "text/event-stream" }))).toBe(false)
    expect(isJsonMediaType(new Headers())).toBe(false)
  })
})
