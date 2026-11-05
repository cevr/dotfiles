// A body read whole, but never past its bound: an untrusted stream cannot
// grow memory, and bytes that are not UTF-8 are refused.
import { Effect, Schema } from "effect"

/** The body is longer than its bound. */
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {
  message: Schema.String,
}) {}

/** The body's bytes are not UTF-8. */
export class BodyNotUtf8 extends Schema.TaggedError<BodyNotUtf8>()("BodyNotUtf8", {
  message: Schema.String,
}) {}

/** The stream failed while it was read; `cause` is its error. */
export class BodyReadFailed extends Schema.TaggedError<BodyReadFailed>()("BodyReadFailed", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export type BodyError = BodyTooLarge | BodyNotUtf8 | BodyReadFailed

export const bodyTooLarge = (label: string, limit: number) =>
  new BodyTooLarge({ message: `${label} exceeds ${limit} byte limit` })

type Read =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "too-large" }
  | { readonly type: "not-utf8" }
  | { readonly type: "failed"; readonly error: unknown }

async function readAll(body: ReadableStream<Uint8Array>, limit: number): Promise<Read> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const parts: string[] = []
  let total = 0
  const stop = async (read: Read, reason?: unknown): Promise<Read> => {
    await reader.cancel(reason).catch(() => {})
    return read
  }
  try {
    while (true) {
      const next = await reader.read().then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!next.ok) return await stop({ type: "failed", error: next.error }, next.error)
      if (next.result.done) break
      total += next.result.value.byteLength
      if (total > limit) return await stop({ type: "too-large" })
      const decoded = decode(decoder, next.result.value)
      if (decoded === undefined) return await stop({ type: "not-utf8" })
      parts.push(decoded)
    }
    const tail = decode(decoder)
    if (tail === undefined) return { type: "not-utf8" }
    parts.push(tail)
    return { type: "text", text: parts.join("") }
  } finally {
    reader.releaseLock()
  }
}

function decode(decoder: TextDecoder, bytes?: Uint8Array): string | undefined {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true })
  } catch {
    return undefined
  }
}

/** `body` as text, at most `limit` bytes of UTF-8; `label` names it in a failure. No body reads as "". */
export const readBoundedText = (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
): Effect.Effect<string, BodyError> =>
  body === null
    ? Effect.succeed("")
    : Effect.promise(() => readAll(body, limit)).pipe(
        Effect.flatMap((read): Effect.Effect<string, BodyError> => {
          switch (read.type) {
            case "text":
              return Effect.succeed(read.text)
            case "too-large":
              return Effect.fail(bodyTooLarge(label, limit))
            case "not-utf8":
              return Effect.fail(new BodyNotUtf8({ message: `${label} is not valid UTF-8` }))
            case "failed":
              return Effect.fail(
                new BodyReadFailed({
                  message: read.error instanceof Error ? read.error.message : `${label} could not be read`,
                  cause: read.error,
                }),
              )
          }
        }),
      )
