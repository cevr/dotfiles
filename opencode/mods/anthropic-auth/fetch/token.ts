// Anthropic's OAuth token endpoint over fetch: one POST per call, never
// retried, since a refresh token may rotate once the request lands.
import { Clock, Effect, Layer } from "effect"
import { contentLength } from "../content-headers.ts"
import {
  EXCHANGE_FAILED_MESSAGE,
  exchangeBody,
  isSendableRefreshToken,
  isTransientNetworkError,
  MAX_TOKEN_RESPONSE_BYTES,
  readTokenGrant,
  refreshBody,
  TOKEN_HEADERS,
  TOKEN_TIMEOUT_MS,
  TOKEN_URL,
  type TokenGrant,
} from "../oauth.ts"
import { parseJson } from "../json.ts"
import { ExchangeFailed, TokenEndpoint, TokenRefused, TokenRequestBroken } from "../service.ts"
import { readBoundedText } from "./body.ts"

/** The fetch the endpoint calls: the global one live, a stand-in in tests. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** What one token request came to. */
type Answer =
  | { readonly type: "grant"; readonly grant: TokenGrant }
  /** The endpoint answered `status` and no grant; 0 when no answer came. */
  | { readonly type: "refused"; readonly status: number }
  /** The request failed in a way that is not the network's: its token may be spent. */
  | { readonly type: "broken"; readonly error: unknown }

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A failure as the token request's answer: no answer when the network failed, else broken. */
const failed = (error: unknown): Answer =>
  isTransientNetworkError(error) ? { type: "refused", status: 0 } : { type: "broken", error }

/** The grant a successful response carries, or a refusal with its status when it carries none. */
const grantOf = (response: Response): Effect.Effect<Answer> => {
  const declared = contentLength(response.headers)
  if (declared !== undefined && declared > MAX_TOKEN_RESPONSE_BYTES) {
    return Effect.promise(() => response.body?.cancel().catch(() => {}) ?? Promise.resolve()).pipe(
      Effect.as<Answer>({ type: "refused", status: response.status }),
    )
  }
  return readBoundedText(response.body, MAX_TOKEN_RESPONSE_BYTES, "Anthropic token response").pipe(
    Effect.flatMap((text) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now): Answer => {
          const grant = readTokenGrant(parseJson(text), now)
          return grant === undefined ? { type: "refused", status: response.status } : { type: "grant", grant }
        }),
      ),
    ),
    Effect.catchTags({
      BodyTooLarge: () => Effect.succeed<Answer>({ type: "refused", status: response.status }),
      BodyNotUtf8: () => Effect.succeed<Answer>({ type: "refused", status: response.status }),
      BodyReadFailed: (error) => Effect.succeed(failed(error.cause)),
    }),
  )
}

const post = (fetch: Fetch, body: string): Effect.Effect<Answer> =>
  Effect.promise(() =>
    fetch(TOKEN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      redirect: "error",
      headers: TOKEN_HEADERS,
      body,
    }).then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ).pipe(
    Effect.flatMap((sent) => {
      if (!sent.ok) return Effect.succeed(failed(sent.error))
      const { response } = sent
      if (!response.ok) {
        return Effect.promise(() => response.body?.cancel().catch(() => {}) ?? Promise.resolve()).pipe(
          Effect.as<Answer>({ type: "refused", status: response.status }),
        )
      }
      return grantOf(response)
    }),
  )

/** The token endpoint on `fetch`. */
export const layer = (fetch: Fetch) =>
  Layer.succeed(TokenEndpoint, {
    exchange: (callback, verifier, redirectUri) =>
      post(fetch, exchangeBody(callback, verifier, redirectUri)).pipe(
        Effect.flatMap((answer) =>
          answer.type === "grant"
            ? Effect.succeed(answer.grant)
            : Effect.fail(
                new ExchangeFailed({
                  message: answer.type === "refused" ? EXCHANGE_FAILED_MESSAGE : errorMessage(answer.error),
                }),
              ),
        ),
      ),
    refresh: (refreshToken) =>
      isSendableRefreshToken(refreshToken)
        ? post(fetch, refreshBody(refreshToken)).pipe(
            Effect.flatMap((answer): Effect.Effect<TokenGrant, TokenRefused | TokenRequestBroken> =>
              answer.type === "grant"
                ? Effect.succeed(answer.grant)
                : answer.type === "refused"
                  ? Effect.fail(new TokenRefused({ status: answer.status }))
                  : Effect.fail(new TokenRequestBroken({ message: errorMessage(answer.error) })),
            ),
          )
        : Effect.fail(new TokenRefused({ status: 400 })),
  })
