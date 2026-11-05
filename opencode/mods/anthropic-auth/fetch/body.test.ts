import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BodyNotUtf8, BodyReadFailed, bodyTooLarge, readBoundedText } from "./body.ts"

const encoder = new TextEncoder()

function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

const read = (stream: ReadableStream<Uint8Array> | null, limit: number) =>
  Effect.runPromise(readBoundedText(stream, limit, "test body"))
const failure = (stream: ReadableStream<Uint8Array>, limit: number) =>
  Effect.runPromise(Effect.flip(readBoundedText(stream, limit, "test body")))

describe("readBoundedText", () => {
  test("decodes UTF-8 split across chunks", async () => {
    const bytes = encoder.encode("Привет 🚀")
    expect(await read(body([bytes.slice(0, 3), bytes.slice(3, 11), bytes.slice(11)]), bytes.byteLength)).toBe(
      "Привет 🚀",
    )
  })

  test("reads no body as the empty string", async () => {
    expect(await read(null, 4)).toBe("")
  })

  test("rejects a chunked body above the byte limit", async () => {
    expect(await failure(body([encoder.encode("123"), encoder.encode("45")]), 4)).toEqual(bodyTooLarge("test body", 4))
  })

  test("rejects malformed UTF-8", async () => {
    expect(await failure(body([Uint8Array.of(0xc3, 0x28)]), 10)).toEqual(
      new BodyNotUtf8({ message: "test body is not valid UTF-8" }),
    )
  })

  test("cancels the source after malformed UTF-8", async () => {
    let cancelled = false
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xc3, 0x28))
      },
      cancel() {
        cancelled = true
      },
    })

    expect(await failure(malformed, 10)).toEqual(new BodyNotUtf8({ message: "test body is not valid UTF-8" }))
    expect(cancelled).toBe(true)
  })

  test("a stream that errors fails with its error as the cause", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"))
      },
    })
    const error = await failure(broken, 10)
    expect(error).toBeInstanceOf(BodyReadFailed)
    expect(error.message).toBe("socket reset")
  })
})
