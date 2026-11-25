// One read of Antigravity's quota from Google, as T3 Code makes it
// (antigravityUsageLimits.ts at 55085df2): a refreshable sign-in's access
// token from Google's token endpoint, then a POST of
// `{endpoint}/v1internal:retrieveUserQuotaSummary` to the Code Assist hosts,
// the daily host first for a personal sign-in and the production one first
// for a business one, with the bearer and Antigravity's user agent; when no
// summary reads, `v1internal:fetchAvailableModels`. Each request has
// REQUEST_TIMEOUT_MS, follows no redirect, and goes only to Google's token,
// userinfo and Code Assist hosts: a URL on any other host is refused before
// anything is sent. A failure is a `Why` and nothing else: no response text,
// no header and no token ever reaches it.
import { Clock, Effect, Match, Option, Redacted, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { decodeModels, decodeSummary, firstAnswers, modelWindows, summaryWindows, type Window } from "./quota.ts"
import { type SignIn, SignIn as SignInSchema } from "./signin.ts"
import { type RequestWhy, Why } from "./state.ts"

/** How long one request may take. */
export const REQUEST_TIMEOUT_MS = 3_000
/** An access token this close to its expiry is taken as expired. */
export const EXPIRY_MARGIN_MS = 60_000

/** Google's hosts, the only ones a read may reach. */
export const GOOGLE_HOSTS: ReadonlySet<string> = new Set([
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
])

/** Where a read goes; Google's own by default, another (still one of Google's hosts) to test the refusal. */
export interface Endpoints {
  readonly token: string
  readonly daily: string
  readonly prod: string
}

export const GOOGLE: Endpoints = {
  token: "https://oauth2.googleapis.com/token",
  daily: "https://daily-cloudcode-pa.googleapis.com",
  prod: "https://cloudcode-pa.googleapis.com",
}

/** A personal sign-in is metered on the daily host, a business one on production. */
export const AuthMethod = Schema.Literals(["personal", "business"])
export type AuthMethod = typeof AuthMethod.Type

export const endpointOrder = (endpoints: Endpoints, auth: AuthMethod): ReadonlyArray<string> =>
  Match.value(auth).pipe(
    Match.when("personal", () => [endpoints.daily, endpoints.prod]),
    Match.orElse(() => [endpoints.prod, endpoints.daily]),
  )

/** The user agent Antigravity's own client sends. */
export const userAgent = (platform: string, arch: string) => `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=963137146)`

/** A read that gave no reading, and why. */
export class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", { why: Why }) {}

const failed = (why: RequestWhy, status: Option.Option<number>) =>
  new ReadFailed({
    why: Option.match(status, {
      onNone: () => Why.cases.RequestFailed.make({ why }),
      onSome: (code) => Why.cases.RequestFailed.make({ why, status: code }),
    }),
  })

const statusWhy = (status: number): RequestWhy =>
  Match.value(status).pipe(
    Match.when((code) => code === 401 || code === 403, () => "refused" as const),
    Match.when(429, () => "rate-limited" as const),
    Match.orElse(() => "failed" as const),
  )

const hostOf = (url: string): Option.Option<string> =>
  Option.map(
    Option.filter(Option.liftThrowable((text: string) => new URL(text))(url), (parsed) => parsed.protocol === "https:"),
    (parsed) => parsed.hostname,
  )

/** Refused unless `url` is https on one of Google's hosts. */
export const checkHost = (url: string): Result.Result<string, ReadFailed> =>
  Option.match(Option.filter(hostOf(url), (host) => GOOGLE_HOSTS.has(host)), {
    onNone: () => Result.fail(new ReadFailed({ why: Why.cases.HostRefused.make({ host: Option.getOrElse(hostOf(url), () => url.split("/").slice(0, 3).join("/")) }) })),
    onSome: () => Result.succeed(url),
  })

const NO_REDIRECT: RequestInit = { redirect: "manual", credentials: "omit" }

/** One request's JSON, bounded; any failure is a `ReadFailed` with no text of the response. */
const send = Effect.fn("Antigravity.send")(function* (request: HttpClientRequest.HttpClientRequest) {
  yield* Result.match(checkHost(request.url), { onFailure: Effect.fail, onSuccess: () => Effect.void })
  const client = yield* HttpClient.HttpClient
  const response: HttpClientResponse.HttpClientResponse = yield* client.execute(request).pipe(
    // A redirect is an answer, never followed: it could lead off Google's hosts.
    Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
    Effect.mapError(() => failed("unreachable", Option.none())),
    Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT_MS, orElse: () => Effect.fail(failed("timed-out", Option.none())) }),
  )
  if (response.status < 200 || response.status >= 300) return yield* Effect.fail(failed(statusWhy(response.status), Option.some(response.status)))
  return yield* response.json.pipe(
    Effect.mapError(() => failed("malformed", Option.some(response.status))),
    Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT_MS, orElse: () => Effect.fail(failed("timed-out", Option.none())) }),
  )
})

const TokenAnswer = Schema.Struct({ access_token: Schema.NonEmptyString, expires_in: Schema.Finite.check(Schema.isGreaterThan(0)) })
const decodeTokenAnswer = Schema.decodeUnknownOption(TokenAnswer)

/** An access token and when it expires (epoch ms), redacted. */
export interface Access {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: Option.Option<number>
}

/**
 * The access token a sign-in gives at `now`: a bare one while it has not
 * expired (else `SignInExpired`: only an Antigravity turn renews it), a
 * refreshable one's from Google's token endpoint.
 */
export const accessOf = Effect.fn("Antigravity.accessOf")(function* (signIn: SignIn, endpoints: Endpoints) {
  const now = yield* Clock.currentTimeMillis
  return yield* SignInSchema.match(signIn, {
    Access: ({ access, expiresAt }) => {
      const expired = Option.exists(Option.fromUndefinedOr(expiresAt), (at) => at <= now + EXPIRY_MARGIN_MS)
      if (expired) return Effect.fail(new ReadFailed({ why: Why.cases.SignInExpired.make({}) }))
      return Effect.succeed<Access>({ token: access, expiresAt: Option.fromUndefinedOr(expiresAt) })
    },
    Refreshable: ({ clientId, clientSecret, refreshToken }) =>
      send(
        HttpClientRequest.post(endpoints.token).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: clientId,
            client_secret: Redacted.value(clientSecret),
            refresh_token: Redacted.value(refreshToken),
            grant_type: "refresh_token",
          }),
        ),
      ).pipe(
        Effect.flatMap((body) =>
          Option.match(decodeTokenAnswer(body), {
            onNone: () => Effect.fail(failed("malformed", Option.none())),
            onSome: (answer) => Effect.succeed<Access>({ token: Redacted.make(answer.access_token), expiresAt: Option.some(now + answer.expires_in * 1000) }),
          }),
        ),
      ),
  })
})

/** The windows each endpoint answers for `operation`, in order; a failed one is its failure. */
const ask = Effect.fn("Antigravity.ask")(function* (
  access: Access,
  hosts: ReadonlyArray<string>,
  agent: string,
  project: Option.Option<string>,
  operation: "retrieveUserQuotaSummary" | "fetchAvailableModels",
) {
  const body = Option.match(project, { onNone: () => ({}), onSome: (id) => ({ project: id }) })
  return yield* Effect.forEach(
    hosts,
    (host) =>
      Effect.gen(function* () {
        const requestedAt = yield* Clock.currentTimeMillis
        const answer = yield* send(
          HttpClientRequest.post(`${host}/v1internal:${operation}`).pipe(
            HttpClientRequest.setHeaders({ authorization: `Bearer ${Redacted.value(access.token)}`, "user-agent": agent }),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        return Match.value(operation).pipe(
          Match.when("retrieveUserQuotaSummary", () => Option.getOrElse(Option.map(decodeSummary(answer), (summary) => summaryWindows(summary, requestedAt)), () => [])),
          Match.orElse(() => Option.getOrElse(Option.map(decodeModels(answer), modelWindows), () => [])),
        )
      }).pipe(Effect.result),
    { concurrency: 2 },
  )
})

const windowsOf = (answers: ReadonlyArray<Result.Result<ReadonlyArray<Window>, ReadFailed>>): ReadonlyArray<Window> =>
  firstAnswers(answers.flatMap((answer) => Option.toArray(Result.getSuccess(answer))))

/**
 * A read of the quota with `access`: the summary from each endpoint in the
 * sign-in's order, the first to read a window winning it; the per-model
 * answer when no summary reads. No window at all is the first endpoint's
 * failure when every request failed, else `NoQuota`.
 */
export const readQuota = Effect.fn("Antigravity.readQuota")(function* (
  access: Access,
  hosts: ReadonlyArray<string>,
  agent: string,
  project: Option.Option<string>,
) {
  const summary = yield* ask(access, hosts, agent, project, "retrieveUserQuotaSummary")
  const fromSummary = windowsOf(summary)
  if (fromSummary.length > 0) return fromSummary
  const models = yield* ask(access, hosts, agent, project, "fetchAvailableModels")
  const fromModels = windowsOf(models)
  if (fromModels.length > 0) return fromModels
  const answers = [...summary, ...models]
  const firstFailure = Option.flatMap(
    Option.liftPredicate(answers, (all) => all.every(Result.isFailure)),
    (all) => Option.flatMap(Option.fromUndefinedOr(all[0]), Result.getFailure),
  )
  return yield* Effect.fail(Option.getOrElse(firstFailure, () => new ReadFailed({ why: Why.cases.NoQuota.make({}) })))
})
