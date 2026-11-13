// The keepalive's pings over `fetch`: sent straight to the network, outside
// OpenCode's request hooks, so no plugin and no session sees one. The answer
// is read whole (a one-token reply) and handed back; interrupting the ping
// aborts the request.
import { Effect, Layer } from "effect"
import { PingFailed, Pinger } from "../service.ts"

/** How the pings reach the network: `fetch`, or a stand-in. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const layer = (fetch: Fetch) =>
  Layer.succeed(
    Pinger,
    Pinger.of({
      send: (request) =>
        Effect.tryPromise({
          try: (signal) =>
            fetch(request.url, { method: request.method, headers: request.headers.map(([name, value]) => [name, value]), body: request.body, signal, redirect: "error" }),
          catch: (cause) => new PingFailed({ message: String(cause) }),
        }).pipe(
          Effect.flatMap((response) =>
            Effect.tryPromise({ try: () => response.text(), catch: (cause) => new PingFailed({ message: String(cause) }) }).pipe(
              Effect.map((text) => ({ status: response.status, headers: [...response.headers.entries()], text })),
            ),
          ),
        ),
    }),
  )

/** The pings on the runtime's own `fetch`. */
export const live = layer((input, init) => fetch(input, init))
