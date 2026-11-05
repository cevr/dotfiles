// Untrusted JSON, read without throwing.

/** `text` as JSON, or `undefined` when it is not JSON (JSON itself never holds `undefined`). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}
