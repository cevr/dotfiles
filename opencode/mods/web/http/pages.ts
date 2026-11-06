// Pages over HTTP: a GET through the runtime's fetch, redirects followed,
// reading the body only up to the bytes asked for and dropping the rest of
// the stream. A status other than 2xx, a network failure and the timeout
// fail PageUnreadable.
import { Effect, Layer } from "effect"
import { type Page, PageUnreadable, Pages } from "../service.ts"

/** The agent the built-in webfetch sends, so a site answers this fetch as it answered that one. */
export const USER_AGENT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai"

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.name === "TimeoutError" ? "Request timed out" : cause.message
  return String(cause)
}

const readPage = async (url: string, maxBytes: number, signal: AbortSignal): Promise<Page> => {
  const response = await fetch(url, { redirect: "follow", signal, headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" } })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10)
  const totalBytes = Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined
  let buffer = new Uint8Array(Math.min(maxBytes, totalBytes ?? 64 * 1024))
  let size = 0
  let cut = false
  const reader = response.body?.getReader()
  while (reader !== undefined) {
    const { done, value } = await reader.read()
    if (done) break
    const room = maxBytes - size
    if (value.byteLength > room) {
      cut = true
      if (room > 0) grow(value.subarray(0, room))
      await reader.cancel()
      break
    }
    grow(value)
  }
  return { bytes: buffer.subarray(0, size), contentType: response.headers.get("content-type") ?? "", cut, ...(totalBytes === undefined ? {} : { totalBytes }) }

  function grow(chunk: Uint8Array) {
    if (size + chunk.byteLength > buffer.byteLength) {
      const next = new Uint8Array(Math.min(maxBytes, Math.max(size + chunk.byteLength, buffer.byteLength * 2)))
      next.set(buffer.subarray(0, size))
      buffer = next
    }
    buffer.set(chunk, size)
    size += chunk.byteLength
  }
}

export const layer = Layer.succeed(
  Pages,
  Pages.of({
    read: Effect.fn("Pages.read")(function* (url: string, options: { readonly maxBytes: number; readonly timeoutMs: number }) {
      return yield* Effect.tryPromise({
        try: (signal) => readPage(url, options.maxBytes, AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])),
        catch: (cause) => new PageUnreadable({ url, message: messageOf(cause) }),
      })
    }),
  }),
)
