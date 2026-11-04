// A provider's quota as its auth plugin reads it: each window's use and
// reset, and why the provider refuses an account, if it does. The pool reads
// it over the quota protocol (opencode/quota.ts) and checks it here field by field.
import { Schema } from "effect"

export const QuotaStatus = Schema.Literals(["allowed", "allowed_warning", "rejected"])
export type QuotaStatus = typeof QuotaStatus.Type

export const QuotaWindow = Schema.Struct({
  /** `5h`, `7d`, or a provider's own name for another window. */
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

export const QuotaReading = Schema.Struct({
  at: Schema.Number,
  status: Schema.optionalKey(QuotaStatus),
  windows: Schema.Array(QuotaWindow),
  refusal: Schema.optionalKey(QuotaRefusal),
})
export type QuotaReading = typeof QuotaReading.Type

const isRefusalKind = Schema.is(RefusalKind)
const isStatus = Schema.is(QuotaStatus)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

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
  return {
    at: value.at,
    ...(isStatus(status) ? { status } : {}),
    windows,
    ...(isRecord(refusal) && isRefusalKind(refusal.kind)
      ? { refusal: { kind: refusal.kind, ...(finite(refusal.until) ? { until: refusal.until } : {}) } }
      : {}),
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
