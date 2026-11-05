// A stand-in for herdr's socket server, for tests: a real Unix socket that
// records each request line and answers it the way the test chose (accept,
// refuse, or stay silent). The socket adapter's laws and the acceptance test
// that runs a real OpenCode TUI (tests/herdr.test.ts) both report to it. It
// imports nothing but Bun, so a test on another copy of Effect can use it.
import type { Received } from "../laws.ts"

export type Answer = { readonly kind: "accept" } | { readonly kind: "refuse"; readonly code: string; readonly message: string } | { readonly kind: "silent" }

export interface FakeServer {
  readonly path: string
  /** Every request so far, in arrival order. */
  readonly received: () => ReadonlyArray<Received>
  /** How later requests are answered. */
  readonly answer: (answer: Answer) => void
  readonly stop: () => void
}

/** One request line, when it is one: an object with a string `id` and `method`. */
const parse = (line: string): { readonly id: string; readonly method: string; readonly params: unknown } | undefined => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const id: unknown = Reflect.get(value, "id")
  const method: unknown = Reflect.get(value, "method")
  if (typeof id !== "string" || typeof method !== "string") return undefined
  return { id, method, params: Reflect.get(value, "params") }
}

/** Listens at `path` until `stop`; the reason when it cannot. */
export const listen = (path: string): FakeServer | { readonly failed: string } => {
  const received: Array<Received> = []
  let current: Answer = { kind: "accept" }
  const buffers = new WeakMap<object, string>()
  let server: { stop: (closeActive?: boolean) => void }
  try {
    server = Bun.listen({
      unix: path,
      socket: {
        data(socket, chunk) {
          const lines = (buffers.get(socket) ?? "") + chunk.toString()
          const end = lines.lastIndexOf("\n")
          buffers.set(socket, lines.slice(end + 1))
          for (const line of lines.slice(0, Math.max(0, end)).split("\n")) {
            const request = parse(line)
            if (request === undefined) continue
            received.push({ method: request.method, params: request.params })
            const answer = current
            if (answer.kind === "accept") socket.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`)
            if (answer.kind === "refuse") socket.write(`${JSON.stringify({ id: request.id, error: { code: answer.code, message: answer.message } })}\n`)
          }
        },
      },
    })
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
  return {
    path,
    received: () => [...received],
    answer: (answer) => {
      current = answer
    },
    stop: () => server.stop(true),
  }
}
