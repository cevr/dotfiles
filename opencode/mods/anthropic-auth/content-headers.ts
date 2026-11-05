// The headers that describe a body's bytes: a rewritten body drops them, and
// the declared length bounds a read before it starts.

const BODY_HEADERS = ["content-digest", "content-encoding", "content-length", "content-md5", "content-range", "digest", "etag"]

/** `source` without the headers a rewritten body would make false. */
export function headersAfterBodyTransform(source: Headers): Headers {
  const headers = new Headers(source)
  for (const name of BODY_HEADERS) headers.delete(name)
  return headers
}

/** The declared `content-length`, when it is a safe whole number. */
export function contentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length")
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/** Whether `headers` declare a JSON body (`application/json` or `+json`). */
export function isJsonMediaType(headers: Headers): boolean {
  const mediaType = mediaTypeOf(headers)
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true
}

/** The declared media type, lower-cased, without parameters. */
export const mediaTypeOf = (headers: Headers): string | undefined =>
  headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
