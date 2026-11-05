// A Messages response with its tool names turned back from their aliases, as
// it streams: server-sent events one whole event at a time, JSON through the
// bounded tokenizer. A stream that breaks a bound errors; the transformer
// throws, the error protocol of Web Streams. The response's end, error or
// cancel calls `onFinalize` exactly once.
import { headersAfterBodyTransform, isJsonMediaType, mediaTypeOf } from "../content-headers.ts"
import { createBoundedJsonToolNameStream } from "../streamparser/json-stream.ts"
import { statelessToolNameAliases, TOOL_PREFIX, type ToolNameAliasTable } from "../tool-alias.ts"
import { transformSseEvent } from "./sse-event.ts"

/** Bound an incomplete SSE line so malformed streams cannot grow memory forever. */
export const MAX_SSE_LINE_BYTES = 5 * 1024 * 1024
export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024

function finalizeStream(stream: ReadableStream<Uint8Array>, finalize: () => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read().then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!next.ok) {
        release()
        finalize()
        controller.error(next.error)
      } else if (next.result.done) {
        release()
        finalize()
        controller.close()
      } else {
        controller.enqueue(next.result.value)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).finally(() => {
        release()
        finalize()
      })
    },
  })
}

function createBoundedSseToolNameStream(
  body: ReadableStream<Uint8Array>,
  aliases: ToolNameAliasTable,
): ReadableStream<Uint8Array> {
  let event = new Uint8Array(1024)
  let eventLength = 0
  let lineLength = 0
  let pendingCr = false

  const appendEvent = (bytes: Uint8Array): void => {
    const required = eventLength + bytes.byteLength
    if (required > MAX_SSE_EVENT_BYTES) {
      throw new Error(`SSE event exceeds ${MAX_SSE_EVENT_BYTES} byte limit`)
    }
    if (required > event.byteLength) {
      let capacity = event.byteLength
      while (capacity < required) capacity = Math.min(MAX_SSE_EVENT_BYTES, capacity * 2)
      const expanded = new Uint8Array(capacity)
      expanded.set(event.subarray(0, eventLength))
      event = expanded
    }
    event.set(bytes, eventLength)
    eventLength = required
  }

  const appendContent = (bytes: Uint8Array): void => {
    if (lineLength + bytes.byteLength > MAX_SSE_LINE_BYTES) {
      throw new Error(`SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`)
    }
    lineLength += bytes.byteLength
    appendEvent(bytes)
  }

  const dispatch = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (eventLength === 0) return
    controller.enqueue(transformSseEvent(event.slice(0, eventLength), aliases))
    eventLength = 0
  }

  const finishLine = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const blank = lineLength === 0
    lineLength = 0
    if (blank) dispatch(controller)
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let segmentStart = 0
        if (pendingCr) {
          pendingCr = false
          if (chunk[0] === 0x0a) {
            appendEvent(chunk.subarray(0, 1))
            segmentStart = 1
          }
          finishLine(controller)
        }

        for (let index = segmentStart; index < chunk.byteLength; index += 1) {
          const byte = chunk[index]
          if (byte !== 0x0d && byte !== 0x0a) continue

          appendContent(chunk.subarray(segmentStart, index))
          appendEvent(chunk.subarray(index, index + 1))
          if (byte === 0x0d && index + 1 === chunk.byteLength) {
            pendingCr = true
            segmentStart = index + 1
            break
          }
          if (byte === 0x0d && chunk[index + 1] === 0x0a) {
            appendEvent(chunk.subarray(index + 1, index + 2))
            index += 1
          }
          finishLine(controller)
          segmentStart = index + 1
        }
        appendContent(chunk.subarray(segmentStart))
      },
      flush(controller) {
        if (pendingCr) {
          pendingCr = false
          finishLine(controller)
        }
        dispatch(controller)
      },
    }),
  )
}

/** `response` streaming with its tool names turned back; a response that is not a success, JSON or SSE goes through as it came. */
export function createStrippedStream(
  response: Response,
  aliases: ToolNameAliasTable = statelessToolNameAliases(),
  onFinalize: () => void = () => {},
): Response {
  let finalized = false
  const finalize = () => {
    if (finalized) return
    finalized = true
    onFinalize()
  }

  if (!response.ok || !response.body) {
    finalize()
    return response
  }
  if (isJsonMediaType(response.headers)) {
    const stream = finalizeStream(
      createBoundedJsonToolNameStream(response.body, TOOL_PREFIX, (alias) => aliases.decode(alias)),
      finalize,
    )
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: headersAfterBodyTransform(response.headers),
    })
  }
  if (mediaTypeOf(response.headers) !== "text/event-stream") {
    finalize()
    return response
  }

  const stream = finalizeStream(createBoundedSseToolNameStream(response.body, aliases), finalize)
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: headersAfterBodyTransform(response.headers),
  })
}
