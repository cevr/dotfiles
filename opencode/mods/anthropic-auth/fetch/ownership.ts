// Which requests this plugin sent, and what their responses need: the tool
// names it aliased (an alias lease) and the login a request went out on.
//
// OpenCode can dispose and recreate a plugin while a request is in flight, so
// the response may reach a newer setup than the one that aliased its tool
// names. Ownership (`Ownership`) is therefore process-wide; alias leases and
// the connections a token was seen on stay with one setup. A request rebuilt
// by the host (not the object the hook set) is matched by an HMAC of its
// method, URL, token and body under the setup's own key, so a fingerprint
// names no credential and cannot be forged from outside.
//
// Leases and connections expire a while after their last use. They expire
// lazily, on the next look, by the time the setup's clock says.
import { createHmac, type Hmac } from "node:crypto"
import { Effect, Result, Schema } from "effect"
import { contentLength } from "../content-headers.ts"
import { AMBIGUOUS_CONNECTION, UNKNOWN_CONNECTION } from "../rate-limit.ts"
import { tokenKey } from "../refresh.ts"
import type { ToolNameAliasTable } from "../tool-alias.ts"
import { bodyTooLarge, type BodyError, readBoundedText } from "./body.ts"

export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
export const MAX_ACTIVE_ALIAS_REQUESTS = 256
export const ALIAS_REQUEST_TTL_MS = 5 * 60_000
export const MAX_TRACKED_CONNECTIONS = 256
export const CONNECTION_TRACKING_TTL_MS = 5 * 60_000
export const MAX_ACTIVE_RESPONSE_TRANSFORMS = 256
const MAX_RECONSTRUCTED_ALIAS_LOOKUPS = 32
const MAX_TRACKED_REQUEST_URL_BYTES = 8 * 1024

/** A request this plugin transformed could not be tracked: it is not sent. */
export class RequestUntracked extends Schema.TaggedError<RequestUntracked>()("RequestUntracked", {
  message: Schema.String,
}) {}

// ── the process's ownership ──

/** What the whole process knows of the requests every setup sent. */
export interface Ownership {
  /** The Messages requests a setup transformed: their responses are this plugin's to turn back. */
  readonly transformed: WeakSet<Request>
  /** The requests a setup refused, with the `retry-after` (seconds) each answers with. */
  readonly refused: WeakMap<Request, number>
  /** A slot for one response transform, and its release; none past the bound. */
  readonly acquireTransform: () => Result.Result<() => void, RequestUntracked>
}

export const makeOwnership = (): Ownership => {
  let active = 0
  return {
    transformed: new WeakSet(),
    refused: new WeakMap(),
    acquireTransform: () => {
      if (active >= MAX_ACTIVE_RESPONSE_TRANSFORMS) {
        return Result.fail(new RequestUntracked({ message: "Too many active Anthropic response transforms" }))
      }
      active += 1
      let held = true
      return Result.succeed(() => {
        if (!held) return
        held = false
        active -= 1
      })
    },
  }
}

// ── request fingerprints ──

const encoder = new TextEncoder()

function updateFramed(hmac: Hmac, bytes: Uint8Array): void {
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.byteLength))
  hmac.update(length)
  hmac.update(bytes)
}

/** The key of the bearer token a request carries: its hash, never the token. */
function authorizationKey(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return undefined
  return tokenKey(authorization.slice("Bearer ".length))
}

function leaseKey(ownershipKey: Uint8Array, request: Request, body: string): string | undefined {
  const authorization = authorizationKey(request)
  if (!authorization) return undefined
  const urlBytes = encoder.encode(request.url)
  if (urlBytes.byteLength > MAX_TRACKED_REQUEST_URL_BYTES) return undefined
  const bodyBytes = encoder.encode(body)
  const hmac = createHmac("sha256", ownershipKey)
  hmac.update("opencode-anthropic-auth/request-ownership/v1")
  updateFramed(hmac, encoder.encode(request.method))
  updateFramed(hmac, urlBytes)
  updateFramed(hmac, encoder.encode(authorization))
  updateFramed(hmac, bodyBytes)
  return `${bodyBytes.byteLength}:${hmac.digest("base64url")}`
}

// ── alias leases ──

/** The aliases of one sent body, shared by every identical request while it is held. */
export interface AliasLease {
  readonly key: string
  readonly aliases: ToolNameAliasTable
  references: number
  activeResponses: number
  active: boolean
  retired: boolean
  /** When an idle lease lapses (epoch ms); none while a response holds it. */
  expiresAt: number | undefined
}

export interface AliasLeases {
  /** Hold `aliases` for `request`, whose sent body is `body`; a request that cannot be tracked fails. */
  readonly register: (
    request: Request,
    body: string,
    aliases: ToolNameAliasTable,
    now: number,
  ) => Result.Result<void, RequestUntracked>
  /** The lease of a response's request, held for the response; a rebuilt request is matched by its body. */
  readonly resolve: (request: Request, now: number) => Effect.Effect<AliasLease | undefined, BodyError>
  /** A response is done with its lease. */
  readonly release: (request: Request, lease: AliasLease, now: number) => void
  /** The setup is going: no lease takes a new response, and each lapses once its responses end. */
  readonly retireAll: () => void
}

export const makeAliasLeases = (ownershipKey: Uint8Array): AliasLeases => {
  const byRequest = new WeakMap<Request, AliasLease>()
  const byFingerprint = new Map<string, AliasLease>()
  let reconstructedLookups = 0

  const expire = (lease: AliasLease): void => {
    if (!lease.active) return
    lease.active = false
    if (byFingerprint.get(lease.key) === lease) byFingerprint.delete(lease.key)
    lease.expiresAt = undefined
    lease.aliases.dispose()
  }

  /** Expire `lease` if its idle time ran out. */
  const lapse = (lease: AliasLease, now: number): void => {
    if (lease.expiresAt !== undefined && now >= lease.expiresAt && lease.activeResponses === 0) expire(lease)
  }

  const sweep = (now: number): void => {
    for (const lease of byFingerprint.values()) lapse(lease, now)
  }

  const schedule = (lease: AliasLease, now: number): void => {
    if (!lease.active || lease.retired || lease.activeResponses > 0) return
    lease.expiresAt = now + ALIAS_REQUEST_TTL_MS
  }

  const begin = (lease: AliasLease): void => {
    if (!lease.active || lease.retired) return
    if (lease.references <= lease.activeResponses) lease.references += 1
    lease.activeResponses += 1
    lease.expiresAt = undefined
  }

  const retire = (lease: AliasLease): void => {
    if (!lease.active || lease.retired) return
    lease.retired = true
    if (byFingerprint.get(lease.key) === lease) byFingerprint.delete(lease.key)
    lease.expiresAt = undefined
    if (lease.activeResponses === 0) expire(lease)
    else lease.references = lease.activeResponses
  }

  const untracked = (aliases: ToolNameAliasTable, message: string) => {
    aliases.dispose()
    return Result.fail(new RequestUntracked({ message }))
  }

  const register: AliasLeases["register"] = (request, body, aliases, now) => {
    const key = leaseKey(ownershipKey, request, body)
    if (!key) return untracked(aliases, "Unable to track transformed Anthropic request")
    sweep(now)
    const existing = byFingerprint.get(key)
    if (existing?.active && !existing.retired) {
      aliases.dispose()
      existing.references += 1
      byRequest.set(request, existing)
      schedule(existing, now)
      return Result.void
    }
    if (byFingerprint.size >= MAX_ACTIVE_ALIAS_REQUESTS) {
      return untracked(aliases, "Too many active Anthropic tool-name alias mappings")
    }
    const lease: AliasLease = {
      key,
      aliases,
      references: 1,
      activeResponses: 0,
      active: true,
      retired: false,
      expiresAt: undefined,
    }
    byFingerprint.set(key, lease)
    byRequest.set(request, lease)
    schedule(lease, now)
    return Result.void
  }

  const lookup = (request: Request, now: number): Effect.Effect<AliasLease | undefined, BodyError> =>
    Effect.gen(function* () {
      const declaredLength = contentLength(request.headers)
      if (declaredLength !== undefined && declaredLength > MAX_REQUEST_BODY_BYTES) {
        return yield* bodyTooLarge("Anthropic request body", MAX_REQUEST_BODY_BYTES)
      }
      const body = yield* readBoundedText(request.clone().body, MAX_REQUEST_BODY_BYTES, "Anthropic request body")
      const key = leaseKey(ownershipKey, request, body)
      if (!key) return undefined
      const lease = byFingerprint.get(key)
      if (lease !== undefined) lapse(lease, now)
      if (!lease?.active) return undefined
      begin(lease)
      byRequest.set(request, lease)
      return lease
    })

  const resolve: AliasLeases["resolve"] = (request, now) =>
    Effect.suspend(() => {
      const direct = byRequest.get(request)
      if (direct !== undefined) lapse(direct, now)
      if (direct?.active && !direct.retired) {
        begin(direct)
        return Effect.succeed(direct)
      }
      if (direct) byRequest.delete(request)
      if (!request.body) return Effect.succeed(undefined)
      if (request.bodyUsed || request.body.locked) return Effect.succeed(undefined)
      if (reconstructedLookups >= MAX_RECONSTRUCTED_ALIAS_LOOKUPS) return Effect.succeed(undefined)
      reconstructedLookups += 1
      return lookup(request, now).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reconstructedLookups -= 1
          }),
        ),
      )
    })

  const release: AliasLeases["release"] = (request, lease, now) => {
    byRequest.delete(request)
    if (!lease.active) return
    if (lease.activeResponses > 0) lease.activeResponses -= 1
    lease.references -= 1
    if (lease.retired && lease.activeResponses === 0) expire(lease)
    // A rebuilt request still reading its body may be about to claim this
    // lease: it idles out instead of going now.
    else if (lease.references <= 0 && reconstructedLookups === 0) expire(lease)
    else schedule(lease, now)
  }

  return {
    register,
    resolve,
    release,
    retireAll: () => {
      for (const lease of byFingerprint.values()) retire(lease)
      byFingerprint.clear()
    },
  }
}

// ── connections ──

interface ConnectionEntry {
  readonly description: string
  readonly credentialID: string | undefined
  readonly expiresAt: number
}

/** The login each request went out on, so its response names it (a 429's diagnostic, a refusal's credential). */
export interface Connections {
  readonly remember: (request: Request, description: string, credentialID: string | undefined, now: number) => void
  /** How a request's login is named; `UNKNOWN_CONNECTION` when it is not known. */
  readonly connectionFor: (request: Request, now: number) => string
  /** The credential a request went out on, if one did. */
  readonly credentialFor: (request: Request, now: number) => string | undefined
  readonly clear: () => void
}

export const makeConnections = (): Connections => {
  const byRequest = new WeakMap<Request, string>()
  const credentialByRequest = new WeakMap<Request, string>()
  // A rebuilt request is found by the token it carries.
  const byAuthorization = new Map<string, ConnectionEntry>()

  const entry = (key: string, now: number): ConnectionEntry | undefined => {
    const found = byAuthorization.get(key)
    if (found === undefined) return undefined
    if (now < found.expiresAt) return found
    byAuthorization.delete(key)
    return undefined
  }

  const sweep = (now: number): void => {
    for (const key of byAuthorization.keys()) entry(key, now)
  }

  return {
    remember: (request, description, credentialID, now) => {
      byRequest.set(request, description)
      if (credentialID !== undefined) credentialByRequest.set(request, credentialID)
      const key = authorizationKey(request)
      if (!key) return
      sweep(now)
      const existing = entry(key, now)
      if (!existing && byAuthorization.size >= MAX_TRACKED_CONNECTIONS) return
      byAuthorization.set(key, {
        description: !existing || existing.description === description ? description : AMBIGUOUS_CONNECTION,
        // One access token belongs to one credential; a token seen on two
        // credentials names neither.
        credentialID: !existing || existing.credentialID === credentialID ? credentialID : undefined,
        expiresAt: now + CONNECTION_TRACKING_TTL_MS,
      })
    },
    connectionFor: (request, now) => {
      const direct = byRequest.get(request)
      if (direct) return direct
      const key = authorizationKey(request)
      if (!key) return UNKNOWN_CONNECTION
      return entry(key, now)?.description ?? UNKNOWN_CONNECTION
    },
    credentialFor: (request, now) => {
      const direct = credentialByRequest.get(request)
      if (direct) return direct
      const key = authorizationKey(request)
      if (!key) return undefined
      return entry(key, now)?.credentialID
    },
    clear: () => byAuthorization.clear(),
  }
}
