// Anthropic's usage endpoints over fetch: what a login has left of its
// windows, and the claim of one of its reset grants (its organization read
// from the login's profile first, as Claude Code does).
import { Cause, Effect, Layer } from "effect"
import { OAUTH_BETA } from "../betas.ts"
import type { Endpoint } from "../endpoint.ts"
import { parseJson } from "../json.ts"
import {
  type ClaimAnswer,
  claimAnswerOf,
  GRANT_ID,
  organizationOf,
  PROFILE_PATH,
  REQUEST_ID,
  RESET_PROGRAM,
  RESET_TIMEOUT_MS,
  resetPath,
  USAGE_MAX_BYTES,
  USAGE_PATH,
  USAGE_QUERY,
  USAGE_TIMEOUT_MS,
} from "../quota.ts"
import { type UsageAnswer, UsageEndpoint, UsageFailed } from "../service.ts"
import { readBoundedText } from "./body.ts"
import type { Fetch } from "./token.ts"

const cancel = (response: Response) => Effect.promise(() => response.body?.cancel().catch(() => {}) ?? Promise.resolve())

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const headersOf = (access: string, userAgent: string) => ({
  authorization: `Bearer ${access}`,
  "anthropic-beta": OAUTH_BETA,
  "user-agent": userAgent,
  accept: "application/json",
})

/** A response's body as JSON, bounded; none when it does not read. */
const jsonOf = (response: Response, what: string) =>
  readBoundedText(response.body, USAGE_MAX_BYTES, what).pipe(
    Effect.map(parseJson),
    Effect.orElseSucceed(() => undefined),
  )

/** The usage endpoints on `endpoint`'s origin, over `fetch`. */
export const layer = (fetch: Fetch, endpoint: Endpoint) =>
  Layer.succeed(UsageEndpoint, {
    read: (access, userAgent) => {
      const url = endpoint.apiUrl(USAGE_PATH)
      url.search = USAGE_QUERY
      if (!endpoint.isTrusted(url)) return Effect.succeed<UsageAnswer>({ status: "unread" })
      return Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "GET",
            headers: headersOf(access, userAgent),
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
    reset: (access, userAgent, grantID, requestID) =>
      Effect.gen(function* () {
        if (!GRANT_ID.test(grantID) || !REQUEST_ID.test(requestID))
          return { outcome: "failed", message: "refusing to claim with a malformed grant or request id" } satisfies ClaimAnswer
        const profileUrl = endpoint.apiUrl(PROFILE_PATH)
        if (!endpoint.isTrusted(profileUrl)) return { outcome: "failed", message: "the endpoint is not trusted" } satisfies ClaimAnswer
        const profile = yield* Effect.tryPromise(() =>
          fetch(profileUrl, { method: "GET", headers: headersOf(access, userAgent), redirect: "error", signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) }),
        )
        if (profile.status === 401 || profile.status === 403) {
          yield* cancel(profile)
          return { outcome: "signed-out", message: `the profile was refused: ${profile.status}` } satisfies ClaimAnswer
        }
        if (!profile.ok) {
          yield* cancel(profile)
          return { outcome: "failed", message: `the profile answered ${profile.status}` } satisfies ClaimAnswer
        }
        const organization = organizationOf(yield* jsonOf(profile, "Anthropic profile response"))
        if (organization === undefined) return { outcome: "failed", message: "the profile names no organization" } satisfies ClaimAnswer
        const response = yield* Effect.tryPromise(() =>
          fetch(endpoint.apiUrl(resetPath(organization)), {
            method: "POST",
            headers: { ...headersOf(access, userAgent), "content-type": "application/json" },
            body: JSON.stringify({ program: RESET_PROGRAM, grant_id: grantID, request_id: requestID }),
            redirect: "error",
            signal: AbortSignal.timeout(RESET_TIMEOUT_MS),
          }),
        )
        if (!response.ok) {
          yield* cancel(response)
          return claimAnswerOf(response.status, undefined)
        }
        return claimAnswerOf(response.status, yield* jsonOf(response, "Anthropic reset response"))
      }).pipe(Effect.catchCause((cause) => Effect.succeed<ClaimAnswer>({ outcome: "failed", message: message(Cause.squash(cause)) }))),
  })
