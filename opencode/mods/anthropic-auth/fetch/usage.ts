// Anthropic's usage endpoint over fetch: what a login has left of its windows.
import { Effect, Layer } from "effect"
import { OAUTH_BETA } from "../betas.ts"
import type { Endpoint } from "../endpoint.ts"
import { parseJson } from "../json.ts"
import { USAGE_MAX_BYTES, USAGE_PATH, USAGE_TIMEOUT_MS } from "../quota.ts"
import { type UsageAnswer, UsageEndpoint, UsageFailed } from "../service.ts"
import { readBoundedText } from "./body.ts"
import type { Fetch } from "./token.ts"

const cancel = (response: Response) => Effect.promise(() => response.body?.cancel().catch(() => {}) ?? Promise.resolve())

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The usage endpoint on `endpoint`'s origin, over `fetch`. */
export const layer = (fetch: Fetch, endpoint: Endpoint) =>
  Layer.succeed(UsageEndpoint, {
    read: (access, userAgent) => {
      const url = endpoint.apiUrl(USAGE_PATH)
      if (!endpoint.isTrusted(url)) return Effect.succeed<UsageAnswer>({ status: "unread" })
      return Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "GET",
            headers: {
              authorization: `Bearer ${access}`,
              "anthropic-beta": OAUTH_BETA,
              "user-agent": userAgent,
              accept: "application/json",
            },
            redirect: "error",
            signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
          }),
        catch: (error) => new UsageFailed({ message: message(error) }),
      }).pipe(
        Effect.flatMap((response): Effect.Effect<UsageAnswer, UsageFailed> => {
          if (response.status === 401) return cancel(response).pipe(Effect.as<UsageAnswer>({ status: "unauthorized" }))
          if (!response.ok) return cancel(response).pipe(Effect.as<UsageAnswer>({ status: "unread" }))
          return readBoundedText(response.body, USAGE_MAX_BYTES, "Anthropic usage response").pipe(
            Effect.mapError((error) => new UsageFailed({ message: error.message })),
            Effect.map((text): UsageAnswer => {
              const body = parseJson(text)
              return body === undefined ? { status: "unread" } : { status: "ok", body }
            }),
          )
        }),
      )
    },
  })
