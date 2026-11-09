// A provider's quota as its auth plugin reads it: each window's use and
// reset, and why the provider refuses an account, if it does. The pool reads
// it over the quota protocol (opencode/quota.ts) and checks it here field by field.
import { Schema } from "effect"

export const QuotaStatus = Schema.Literals(["allowed", "allowed_warning", "rejected"])
export type QuotaStatus = typeof QuotaStatus.Type

export const QuotaWindow = Schema.Struct({
  /**
   * `5h`, `7d`, or a provider's own name for another window. A window of one
   * model's own is `<window>:<model>` (`7d:Fable`): it counts that model's use
   * on top of the account's windows, and limits only that model (`scopeOf`).
   */
  name: Schema.String,
  /** 0 to 1. */
  utilization: Schema.Number,
  /** Epoch ms. */
  resetAt: Schema.optionalKey(Schema.Number),
})
export type QuotaWindow = typeof QuotaWindow.Type

export const RefusalKind = Schema.Literals(["usage-limit", "rate-limit", "unauthorized", "signin"])
export type RefusalKind = typeof RefusalKind.Type

/** Why an account cannot take a request now, and until when (epoch ms). */
export const QuotaRefusal = Schema.Struct({
  kind: RefusalKind,
  until: Schema.optionalKey(Schema.Number),
})
export type QuotaRefusal = typeof QuotaRefusal.Type

/**
 * One grant of rate-limit resets: a Claude `cedar_ember` grant (`count` resets
 * left on it) or a Codex reset credit (one reset). `id` is what a claim names;
 * it is an opaque grant id, not a credential. `usable` when it can be claimed
 * now (not paused, not spent, not expired); `expiresAt` in epoch ms.
 */
export const ResetCredit = Schema.Struct({
  id: Schema.String,
  count: Schema.Number,
  usable: Schema.Boolean,
  status: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.Number),
  /**
   * The windows a claim empties, as the provider names them: a Claude grant
   * read on 2026-11-09 clears `five_hour` and `seven_day_overage_included`
   * (the model's own week), not `seven_day`.
   */
  clears: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type ResetCredit = typeof ResetCredit.Type

/**
 * The resets an account holds: how many it can claim now, when the soonest
 * usable one expires, and each grant as listed (none when only the count was read).
 */
export const QuotaResets = Schema.Struct({
  available: Schema.Number,
  nextExpiresAt: Schema.optionalKey(Schema.Number),
  credits: Schema.Array(ResetCredit),
})
export type QuotaResets = typeof QuotaResets.Type

export const QuotaReading = Schema.Struct({
  at: Schema.Number,
  status: Schema.optionalKey(QuotaStatus),
  windows: Schema.Array(QuotaWindow),
  refusal: Schema.optionalKey(QuotaRefusal),
  /** The account's rate-limit resets, when the reading read them (a usage endpoint's; never a response's headers). */
  resets: Schema.optionalKey(QuotaResets),
})
export type QuotaReading = typeof QuotaReading.Type

/** The model a window is scoped to (`7d:Fable` → `Fable`); none for a window of the whole account. */
export const scopeOf = (name: string): string | undefined => {
  const at = name.indexOf(":")
  return at < 0 ? undefined : name.slice(at + 1)
}

/** Whether a window counts against the whole account: every model's requests, and so every placement. */
export const accountWide = (window: QuotaWindow): boolean => scopeOf(window.name) === undefined

/**
 * Whether a window scoped to `scope` (a model's display name, `Fable`) limits
 * the model `modelID` (`claude-fable-5-2`): its id names the scope's words.
 */
export const limitsModel = (scope: string, modelID: string): boolean => {
  const id = modelID.toLowerCase()
  return scope
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((word) => word !== "")
    .every((word) => id.includes(word))
}

/**
 * A reading taken over `held`: the windows scoped to one model and the
 * resets that only a usage endpoint reads are kept from `held` while the new
 * reading has none of its own (a response's headers carry neither), and a
 * kept window only until it resets.
 */
export const carryOver = (held: QuotaReading | undefined, next: QuotaReading, now: number): QuotaReading => {
  if (held === undefined) return next
  const named = new Set(next.windows.map((window) => window.name))
  const kept = held.windows.filter(
    (window) => !accountWide(window) && !named.has(window.name) && window.resetAt !== undefined && window.resetAt > now,
  )
  const resets = next.resets === undefined && held.resets !== undefined ? { resets: held.resets } : {}
  return kept.length === 0 && Object.keys(resets).length === 0 ? next : { ...next, windows: [...next.windows, ...kept], ...resets }
}

const isRefusalKind = Schema.is(RefusalKind)
const isStatus = Schema.is(QuotaStatus)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Resets from another plugin, checked field by field; a malformed credit is left out. */
const asResets = (value: unknown): QuotaResets | undefined => {
  if (!isRecord(value) || !finite(value.available) || !Array.isArray(value.credits)) return undefined
  const credits = value.credits.flatMap((credit): ReadonlyArray<ResetCredit> =>
    isRecord(credit) && typeof credit.id === "string" && finite(credit.count) && typeof credit.usable === "boolean"
      ? [
          {
            id: credit.id,
            count: credit.count,
            usable: credit.usable,
            ...(typeof credit.status === "string" ? { status: credit.status } : {}),
            ...(finite(credit.expiresAt) ? { expiresAt: credit.expiresAt } : {}),
            ...(Array.isArray(credit.clears) ? { clears: credit.clears.filter((name) => typeof name === "string") } : {}),
          },
        ]
      : [],
  )
  return { available: value.available, ...(finite(value.nextExpiresAt) ? { nextExpiresAt: value.nextExpiresAt } : {}), credits }
}

/**
 * A reading from another plugin, checked field by field: RPC output is
 * untyped JSON. A malformed reading is dropped, a malformed window or refusal
 * is left out, and a window's use is clamped to 0..1. Nothing is trusted.
 */
export function asReading(value: unknown): QuotaReading | undefined {
  if (!isRecord(value)) return undefined
  if (!finite(value.at) || !Array.isArray(value.windows)) return undefined
  const windows: Array<QuotaWindow> = []
  for (const window of value.windows) {
    if (!isRecord(window)) continue
    if (typeof window.name !== "string" || !finite(window.utilization)) continue
    windows.push({
      name: window.name,
      utilization: Math.min(Math.max(window.utilization, 0), 1),
      ...(finite(window.resetAt) ? { resetAt: window.resetAt } : {}),
    })
  }
  const refusal = value.refusal
  const status = value.status
  const resets = asResets(value.resets)
  return {
    at: value.at,
    ...(isStatus(status) ? { status } : {}),
    windows,
    ...(isRecord(refusal) && isRefusalKind(refusal.kind)
      ? { refusal: { kind: refusal.kind, ...(finite(refusal.until) ? { until: refusal.until } : {}) } }
      : {}),
    ...(resets === undefined ? {} : { resets }),
  }
}

/**
 * The quota RPC a provider's auth plugin serves for its integration: the
 * newest reading it holds of a login, a fresh read of the login's usage
 * endpoint, and each reading as it comes. The wire contract, kept byte for byte.
 */
export function quotaProtocol(integrationID: string) {
  const credential = {
    type: "object",
    properties: { credentialID: { type: "string" } },
    required: ["credentialID"],
  } as const
  const answer = { type: "object", properties: { reading: {} } } as const
  return {
    id: `credential-quota.${integrationID}`,
    methods: {
      reading: { input: credential, output: answer },
      usage: { input: credential, output: answer },
    },
    events: {
      reading: {
        schema: {
          type: "object",
          properties: { credentialID: { type: "string" }, reading: {} },
          required: ["credentialID", "reading"],
        },
      },
    },
  } as const
}
