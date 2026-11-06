// The HTTP hooks: a request to Anthropic goes out on a Claude Pro/Max login
// the way Claude Code sends it, and its response comes back with the tool
// names OpenCode knows, the quota it carries recorded, a version rejection
// recovered from once, and a 429 named for what it is.
import { type Clock, Effect, Result, Schema } from "effect"
import type { Endpoint } from "../endpoint.ts"
import type { Auth } from "../model.ts"
import { readUnifiedQuota } from "../quota.ts"
import { describeConnection, type RateLimitCategory } from "../rate-limit.ts"
import { type CacheTTL, rewriteRequestBody } from "../request-body.ts"
import { CLAUDE_CODE_SESSION_HEADER, claudeCodeSessionID } from "../session-header.ts"
import { headersAfterBodyTransform, contentLength } from "../content-headers.ts"
import { ToolNameAliasTable, type ToolNameRejected } from "../tool-alias.ts"
import { sentClaudeCodeVersion } from "../version.ts"
import { bodyTooLarge, type BodyError, readBoundedText } from "./body.ts"
import {
  type AliasLease,
  type AliasLeases,
  type Connections,
  MAX_REQUEST_BODY_BYTES,
  type Ownership,
  type RequestUntracked,
} from "./ownership.ts"
import { enhanceRateLimitResponse } from "./rate-limit.ts"
import {
  hasTransformedOAuthShape,
  mergeHeaders,
  refusedRequest,
  refusedResponse,
  routed,
  setOAuthHeaders,
  takeCacheTTL,
  takeCredentialChoice,
} from "./request.ts"
import { createStrippedStream } from "./response-stream.ts"
import { detectClaudeCodeVersionRejection } from "./version-rejection.ts"
import type { LoginFailed } from "../service.ts"

const INTEGRATION_ID = "anthropic"
const MAX_REQUEST_ALIAS_ENTRIES = 256
const MAX_REQUEST_ALIAS_BYTES = 16 * 1024

/** A request would carry OAuth credentials somewhere other than Anthropic (or the configured endpoint). */
export class UntrustedOrigin extends Schema.TaggedError<UntrustedOrigin>()("UntrustedOrigin", {
  message: Schema.String,
}) {}

/** Why a request is not sent. */
export type RequestError = LoginFailed | BodyError | ToolNameRejected | RequestUntracked | UntrustedOrigin

/** Why a response is not delivered. */
export type ResponseError = RequestUntracked

/** The request hook's event, as OpenCode's `http.request` hands it: `request` may be replaced. */
export interface RequestEvent {
  readonly sessionID: string
  /** The agent the request runs as; the host always names it. */
  readonly agent?: string
  readonly model: { readonly providerID: string; readonly id: string }
  request: Request
}

/** The response hook's event, as OpenCode's `http.response` hands it: `response` may be replaced. */
export interface ResponseEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly request: Request
  response: Response
}

/** What one setup's hooks work with. */
export interface Exchange {
  readonly auth: Auth["Service"]
  readonly endpoint: Endpoint
  readonly ownership: Ownership
  readonly leases: AliasLeases
  readonly connections: Connections
  readonly clock: Clock.Clock
  /**
   * The agent's own prompt-cache lifetime (its `request.settings.cacheTTL`,
   * such as an orchestration role's 5 minutes), or undefined when it sets
   * none Anthropic takes or cannot be read.
   */
  readonly ownCacheTTL: (agentID: string) => Effect.Effect<CacheTTL | undefined>
  /** Whether the setup still runs; a disposed one leaves requests as they are. */
  readonly active: () => boolean
}

/** The key a version recovery is limited by: once per session, agent, provider and model. */
const recoveryKey = (sessionID: string, agent: string, providerID: string, modelID: string): string =>
  `${sessionID}\u0000${agent}\u0000${providerID}\u0000${modelID}`

const credentialIDOf = (connection: { readonly type: string; readonly id?: string }): string | undefined =>
  connection.type === "credential" ? connection.id : undefined

/**
 * `http.request`: send a request for the `anthropic` provider on its login,
 * as Claude Code would, its cache written for the lifetime another plugin
 * named (`CACHE_TTL_HEADER`) when it named one, else for the agent's own
 * lifetime when the provider configures one. A login refused for a while
 * sends the request nowhere; the response hook answers it as a retryable 429.
 */
export const onRequest =
  (exchange: Exchange) =>
  (event: RequestEvent): Effect.Effect<void, RequestError> =>
    Effect.gen(function* () {
      const { auth, endpoint, ownership, leases, connections, clock } = exchange
      if (!exchange.active()) return
      if (event.model.providerID !== INTEGRATION_ID) return
      const choice = takeCredentialChoice(event.request)
      const cache = takeCacheTTL(choice.request)
      event.request = cache.request
      const login = yield* auth.login(choice.credentialID).pipe(
        Effect.catchTag("LoginRefused", (refused) =>
          Effect.sync(() => {
            const request = refusedRequest(event.request)
            ownership.refused.set(request, refused.retryAfter)
            event.request = request
            return undefined
          }),
        ),
      )
      if (!exchange.active() || login === undefined) return
      const description = describeConnection(login.connection)
      const credentialID = credentialIDOf(login.connection)
      const sessionHeader = claudeCodeSessionID(event.sessionID)
      const version = yield* auth.version

      const request = event.request
      const url = endpoint.route(new URL(request.url))
      if (!endpoint.isTrusted(url)) {
        return yield* new UntrustedOrigin({
          message: "Refusing to send Anthropic OAuth credentials to an untrusted origin",
        })
      }

      const pathname = url.pathname
      const transformsBody =
        request.method === "POST" && (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")

      if (!transformsBody) {
        const headers = setOAuthHeaders(mergeHeaders(request), login.access, version, event.model.id)
        headers.set(CLAUDE_CODE_SESSION_HEADER, sessionHeader)
        event.request = new Request(routed(request, url), { headers, signal: request.signal, redirect: "error" })
        connections.remember(event.request, description, credentialID, clock.currentTimeMillisUnsafe())
        return
      }

      const hasBody = request.body !== null
      const declaredLength = contentLength(request.headers)
      if (hasBody && declaredLength !== undefined && declaredLength > MAX_REQUEST_BODY_BYTES) {
        return yield* bodyTooLarge("Anthropic request body", MAX_REQUEST_BODY_BYTES)
      }
      const bodyText = hasBody
        ? yield* readBoundedText(request.clone().body, MAX_REQUEST_BODY_BYTES, "Anthropic request body")
        : undefined
      if (!exchange.active()) return
      // Another plugin's lifetime for this request wins over the agent's own.
      const own = cache.ttl === undefined && event.agent !== undefined ? yield* exchange.ownCacheTTL(event.agent) : undefined
      if (!exchange.active()) return
      const aliases = new ToolNameAliasTable({ maxEntries: MAX_REQUEST_ALIAS_ENTRIES, maxBytes: MAX_REQUEST_ALIAS_BYTES })
      const rewrittenBody = bodyText === undefined ? undefined : rewriteRequestBody(bodyText, version, aliases, { named: cache.ttl, own })
      if (rewrittenBody !== undefined && Result.isFailure(rewrittenBody)) {
        aliases.dispose()
        return yield* rewrittenBody.failure
      }
      const body = rewrittenBody?.success
      const bodyChanged = bodyText !== undefined && body !== bodyText

      const headers = setOAuthHeaders(
        bodyChanged ? headersAfterBodyTransform(mergeHeaders(request)) : mergeHeaders(request),
        login.access,
        version,
        event.model.id,
      )
      headers.set(CLAUDE_CODE_SESSION_HEADER, sessionHeader)

      event.request = new Request(url.toString(), {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        redirect: "error",
      })
      const now = clock.currentTimeMillisUnsafe()
      if (pathname === "/v1/messages" && body !== undefined) {
        const registered = leases.register(event.request, body, aliases, now)
        if (Result.isFailure(registered)) {
          event.request = request
          return yield* registered.failure
        }
      } else {
        aliases.dispose()
      }
      if (pathname === "/v1/messages") ownership.transformed.add(event.request)
      connections.remember(event.request, description, credentialID, now)
    })

/**
 * `http.response`: a response to a request this plugin sent. A refused
 * request answers its 429; a success records its quota and streams with the
 * tool names turned back; a failure records the refusal it makes of its login.
 */
export const onResponse =
  (exchange: Exchange) =>
  (event: ResponseEvent): Effect.Effect<void, ResponseError> =>
    Effect.gen(function* () {
      const { auth, endpoint, ownership, leases, connections, clock } = exchange
      if (event.model.providerID !== INTEGRATION_ID) return
      // A refused request went nowhere: it answers as Anthropic's rate limit
      // does, whichever setup refused it.
      const refused = ownership.refused.get(event.request)
      if (refused !== undefined) {
        yield* Effect.promise(() => event.response.body?.cancel() ?? Promise.resolve())
        event.response = refusedResponse(refused)
        return
      }
      if (!exchange.active()) return
      if (!hasTransformedOAuthShape(event.request, endpoint)) return
      const ownedDirectly = ownership.transformed.has(event.request)
      // A direct plugin-owned response survives a best-effort lease failure.
      const lease = yield* leases
        .resolve(event.request, clock.currentTimeMillisUnsafe())
        .pipe(Effect.orElseSucceed((): AliasLease | undefined => undefined))
      if (!ownedDirectly && !lease) return
      const now = clock.currentTimeMillisUnsafe()
      const credentialID = connections.credentialFor(event.request, now)
      const sentHeaders = event.response.headers
      const quota = readUnifiedQuota(sentHeaders, now)

      if (event.response.ok) {
        if (credentialID !== undefined && quota) yield* auth.succeeded(credentialID, quota)
        const aliases = lease?.aliases ?? new ToolNameAliasTable({ maxEntries: 0, maxBytes: 0 })
        const releaseAliases = () => {
          if (lease) leases.release(event.request, lease, clock.currentTimeMillisUnsafe())
          else aliases.dispose()
        }
        const slot = ownership.acquireTransform()
        if (Result.isFailure(slot)) {
          releaseAliases()
          return yield* slot.failure
        }
        const sent = event.response
        // A body the stream cannot take (a locked one) throws here: the slot
        // and the lease are given back before the defect goes on.
        event.response = yield* Effect.sync(() =>
          createStrippedStream(sent, aliases, () => {
            releaseAliases()
            slot.success()
          }),
        ).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              slot.success()
              releaseAliases()
            }),
          ),
        )
        return
      }

      if (lease) leases.release(event.request, lease, now)
      if (!auth.explicitVersion && event.response.status === 400) {
        const sent = sentClaudeCodeVersion(event.request.headers.get("user-agent"))
        const rejection = sent === undefined ? undefined : yield* detectClaudeCodeVersionRejection(event.response, sent)
        if (rejection) {
          const retry = yield* auth.recoverVersion(
            rejection.requiredVersion,
            recoveryKey(event.sessionID, event.agent, event.model.providerID, event.model.id),
          )
          if (retry) {
            const headers = new Headers(event.response.headers)
            headers.set("x-should-retry", "true")
            event.response = new Response(event.response.body, {
              status: event.response.status,
              statusText: event.response.statusText,
              headers,
            })
          }
        }
      }
      const status = event.response.status
      let category: RateLimitCategory | undefined
      if (status === 429) {
        const enhanced = yield* enhanceRateLimitResponse(event.response, connections.connectionFor(event.request, now))
        event.response = enhanced.response
        category = enhanced.category
      }
      if (credentialID === undefined) return
      yield* auth.refused({
        credentialID,
        status,
        category,
        headers: sentHeaders,
        quota,
        now,
        bearer: event.request.headers.get("authorization")?.replace(/^Bearer /, "") || undefined,
      })
    })
