import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { completeImage, decodeBase64, payloads } from "./stream.ts"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const raw = (...lines: ReadonlyArray<string>) => lines.map((line) => `data: ${line}\n\n`).join("")
const sse = (...events: ReadonlyArray<object>) => raw(...events.map((event) => json(event)))

/** An output item as the fake stream sends it. */
interface Item {
  readonly type: string
  readonly status?: string
  readonly result?: string
}

const done = (item: Item) => ({ type: "response.output_item.done", item })

const outcome = (result: Result.Result<string, { readonly code: string; readonly message: string }>) =>
  Result.match(result, { onFailure: (failed) => `${failed.code} ${failed.message}`, onSuccess: (base64) => base64 })

describe("completeImage", () => {
  test("the first completed image_generation_call wins; later ones and generating items are ignored", () => {
    const text = sse(
      { type: "response.created" },
      done({ type: "image_generation_call", status: "generating", result: "R0VO" }),
      done({ type: "message", status: "completed", result: "TVNH" }),
      done({ type: "image_generation_call", status: "completed", result: "Rklyc3Q=" }),
      done({ type: "image_generation_call", status: "completed", result: "U2Vjb25k" }),
    ) + raw("[DONE]")
    expect(outcome(completeImage(text))).toBe("Rklyc3Q=")
  })

  test("an item without a status counts; CRLF and data lines without a space are read", () => {
    const text = `data:${json(done({ type: "image_generation_call", result: "QUJD" }))}\r\n\r\n`
    expect(outcome(completeImage(text))).toBe("QUJD")
  })

  test("a multi-line data payload is joined before it is parsed", () => {
    expect(payloads('event: x\ndata: {"type":\ndata: "a"}\n\n')).toEqual(['{"type":\n"a"}'])
  })

  test("no image is NO_IMAGE; a null result is an empty image", () => {
    expect(outcome(completeImage(sse({ type: "response.completed" })))).toBe("NO_IMAGE Backend returned no image. Try rephrasing the prompt.")
    expect(outcome(completeImage(raw('{"type":"response.output_item.done","item":{"type":"image_generation_call","status":"completed","result":null}}')))).toBe(
      "NO_IMAGE Backend returned an empty image result.",
    )
  })

  test("a stream that says why it failed is GENERATION_FAILED with that reason", () => {
    expect(outcome(completeImage(sse({ type: "response.failed", response: { error: { message: "safety system" } } })))).toBe(
      "GENERATION_FAILED Image generation failed: safety system",
    )
    expect(outcome(completeImage(sse({ type: "error", message: "overloaded" })))).toBe("GENERATION_FAILED Image generation failed: overloaded")
  })

  test("a payload that is not the expected JSON fails the response", () => {
    expect(outcome(completeImage(raw("{not json")))).toBe("GENERATION_FAILED Image generation failed: response does not match the expected schema")
    expect(outcome(completeImage(sse({ item: {} })))).toBe("GENERATION_FAILED Image generation failed: response does not match the expected schema")
  })
})

describe("decodeBase64", () => {
  const decoded = (text: string) => Result.match(decodeBase64(text, "OpenAI"), { onFailure: (failed) => `${failed.code} ${failed.message}`, onSuccess: (data) => [...data].join(",") })

  test("reads padded, unpadded and whitespace-broken base64", () => {
    expect(decoded("YQ==")).toBe("97")
    expect(decoded("YQ")).toBe("97")
    expect(decoded("YW\nJj\tZA")).toBe("97,98,99,100")
  })

  test("invalid base64 is DECODE_FAILED naming the backend", () => expect(decoded("@@@")).toBe("DECODE_FAILED OpenAI returned invalid base64 image data"))
})
