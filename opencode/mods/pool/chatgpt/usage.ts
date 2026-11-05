// The ChatGPT account's Codex quota, as the provider itself measures it: the
// same windows Codex CLI's /status shows, counting every place the account is
// used (this host, the workbox, Codex CLI, the ChatGPT apps). Three ways in,
// all from openai/codex (codex-rs):
// - GET https://chatgpt.com/backend-api/wham/usage with the login's bearer
//   token and `chatgpt-account-id` (backend-client/src/client/rate_limit_resets.rs:128-131,
//   headers in client.rs:367-385): `rate_limit.primary_window` and
//   `secondary_window`, each `used_percent`, `limit_window_seconds` and
//   `reset_at` in Unix seconds (codex-backend-openapi-models rate_limit_window_snapshot.rs).
// - The `x-codex-primary-used-percent`, `-window-minutes` and `-reset-at`
//   headers (and `secondary`) on a response (codex-api/src/rate_limits.rs:22-100).
// - A `codex.rate_limits` frame on the Responses websocket, the transport
//   OpenCode uses for ChatGPT (rate_limits.rs `parse_rate_limit_event`).
// It serves the pool what an auth plugin's quota RPC would (opencode/quota.ts's
// QuotaRpc), since OpenCode's ChatGPT login has none. A failed or refused read
// is no reading: the pace fails open, never holds. No token is kept or logged.
import { Clock, Effect, PubSub, Schema, Stream } from "effect"
import type { QuotaRpc } from "../opencode/quota.ts"
import type { QuotaReading, QuotaWindow } from "../quota.ts"

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

/** A held reading younger than this answers `reading` without asking the endpoint again. */
export const FRESH_MS = 60_000

/** How long the usage endpoint has to answer. */
const TIMEOUT_MS = 10_000

/** What a read of the usage endpoint needs of one login: its access token and its ChatGPT account. */
export interface Login {
  readonly access: string
  readonly accountID?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** The pool's name for a window of `minutes`: the 5-hour and the weekly windows by their usual names. */
export const windowName = (minutes: number) => (minutes === 300 ? "5h" : minutes === 10_080 ? "7d" : `${minutes}m`)

const window = (usedPercent: number, minutes: number | undefined, resetSeconds: number | undefined): QuotaWindow | undefined =>
  minutes === undefined || minutes <= 0
    ? undefined
    : {
        name: windowName(minutes),
        utilization: Math.min(Math.max(usedPercent / 100, 0), 1),
        ...(resetSeconds === undefined ? {} : { resetAt: resetSeconds * 1000 }),
      }

/**
 * A reading of `windows`, refused for its usage limit when the provider says
 * the limit is reached: until the last full window resets, else the first.
 */
const readingOf = (windows: ReadonlyArray<QuotaWindow>, now: number, reached: boolean): QuotaReading => {
  const full = windows.filter((w) => w.utilization >= 1).flatMap((w) => (w.resetAt === undefined ? [] : [w.resetAt]))
  const resets = windows.flatMap((w) => (w.resetAt === undefined ? [] : [w.resetAt]))
  const until = full.length ? Math.max(...full) : resets.length ? Math.min(...resets) : undefined
  return reached
    ? { at: now, status: "rejected", windows, refusal: { kind: "usage-limit", ...(until === undefined ? {} : { until }) } }
    : { at: now, status: "allowed", windows }
}

/** The usage endpoint's answer as a reading; anything else is none. */
export const fromUsage = (body: unknown, now: number): QuotaReading | undefined => {
  if (!isRecord(body) || !isRecord(body.rate_limit)) return undefined
  const limit = body.rate_limit
  const windows = [limit.primary_window, limit.secondary_window].flatMap((w) => {
    if (!isRecord(w) || !finite(w.used_percent) || !finite(w.limit_window_seconds)) return []
    const read = window(w.used_percent, Math.round(w.limit_window_seconds / 60), finite(w.reset_at) ? w.reset_at : undefined)
    return read === undefined ? [] : [read]
  })
  if (!windows.length) return undefined
  return readingOf(windows, now, limit.limit_reached === true || limit.allowed === false)
}

const number = (text: string | null | undefined) => {
  if (text === null || text === undefined || text.trim() === "") return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** A response's `x-codex-*` rate-limit headers as a reading; none when it carries none. */
export const fromHeaders = (header: (name: string) => string | null, now: number): QuotaReading | undefined => {
  const windows = (["primary", "secondary"] as const).flatMap((which) => {
    const used = number(header(`x-codex-${which}-used-percent`))
    if (used === undefined) return []
    const read = window(used, number(header(`x-codex-${which}-window-minutes`)), number(header(`x-codex-${which}-reset-at`)))
    return read === undefined ? [] : [read]
  })
  return windows.length ? readingOf(windows, now, windows.some((w) => w.utilization >= 1)) : undefined
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A websocket frame as a reading, when it is a `codex.rate_limits` event; none otherwise. */
export const fromFrame = (frame: string, now: number): QuotaReading | undefined => {
  // Most frames are output deltas: only parse one that can be the event.
  if (!frame.includes("codex.rate_limits")) return undefined
  const parsed = parseJson(frame)
  if (parsed._tag === "None") return undefined
  const event = parsed.value
  if (!isRecord(event) || event.type !== "codex.rate_limits" || !isRecord(event.rate_limits)) return undefined
  const limits = event.rate_limits
  const windows = [limits.primary, limits.secondary].flatMap((w) => {
    if (!isRecord(w) || !finite(w.used_percent)) return []
    const read = window(w.used_percent, finite(w.window_minutes) ? w.window_minutes : undefined, finite(w.reset_at) ? w.reset_at : undefined)
    return read === undefined ? [] : [read]
  })
  return windows.length ? readingOf(windows, now, windows.some((w) => w.utilization >= 1)) : undefined
}

/** The ChatGPT quota source: the quota RPC the pool reads, and where the hooks hand it what a response showed. */
export interface Source {
  /** A QuotaRpc, typed as it answers. */
  readonly rpc: {
    readonly reading: (input: { readonly credentialID: string }) => Effect.Effect<{ readonly reading?: QuotaReading }>
    readonly usage: (input: { readonly credentialID: string }) => Effect.Effect<{ readonly reading?: QuotaReading }>
    readonly published: Stream.Stream<{ readonly credentialID: string; readonly reading: QuotaReading }>
  }
  /** A reading a response or frame of the login `credentialID` carried. */
  readonly observe: (credentialID: string, reading: QuotaReading) => Effect.Effect<void>
}

export interface Options {
  /** The login a credential id names, refreshed when it is about to expire; none when it is not a ChatGPT login. */
  readonly login: (credentialID: string) => Effect.Effect<Login | undefined, unknown>
  /** The usage endpoint; another one for tests. */
  readonly url?: string
}

export const make = (options: Options) =>
  Effect.gen(function* () {
    const held = new Map<string, QuotaReading>()
    const published = yield* PubSub.unbounded<{ readonly credentialID: string; readonly reading: QuotaReading }>()

    const keep = (credentialID: string, reading: QuotaReading) =>
      Effect.suspend(() => {
        const before = held.get(credentialID)
        if (before !== undefined && before.at > reading.at) return Effect.void
        held.set(credentialID, reading)
        return PubSub.publish(published, { credentialID, reading }).pipe(Effect.asVoid)
      })

    /** A fresh read of the usage endpoint; none on any failure, a refusal or a malformed answer. */
    const fetchUsage = (credentialID: string) =>
      Effect.gen(function* () {
        const login = yield* options.login(credentialID)
        if (login === undefined) return undefined
        const response = yield* Effect.tryPromise((signal) =>
          fetch(options.url ?? USAGE_URL, {
            headers: {
              authorization: `Bearer ${login.access}`,
              ...(login.accountID === undefined ? {} : { "chatgpt-account-id": login.accountID }),
              "user-agent": "codex-cli",
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          }),
        )
        if (!response.ok) return undefined
        const body: unknown = yield* Effect.tryPromise(() => response.json())
        const reading = fromUsage(body, yield* Clock.currentTimeMillis)
        if (reading !== undefined) yield* keep(credentialID, reading)
        return reading
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const rpc: Source["rpc"] = {
      reading: ({ credentialID }) =>
        Effect.gen(function* () {
          const before = held.get(credentialID)
          if (before !== undefined && (yield* Clock.currentTimeMillis) - before.at < FRESH_MS) return { reading: before }
          const reading = (yield* fetchUsage(credentialID)) ?? before
          return reading === undefined ? {} : { reading }
        }),
      usage: ({ credentialID }) => fetchUsage(credentialID).pipe(Effect.map((reading) => (reading === undefined ? {} : { reading }))),
      published: Stream.fromPubSub(published),
    }

    return { rpc: rpc satisfies QuotaRpc, observe: keep } satisfies Source
  })
