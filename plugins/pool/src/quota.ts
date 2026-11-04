/**
 * The quota protocol a provider's auth plugin serves over RPC, as the pool
 * reads it. The pool builds the definition from the integration id, the same
 * way the auth plugin does, so neither imports the other and any provider
 * that serves it can join the pool.
 */

export type QuotaStatus = "allowed" | "allowed_warning" | "rejected"

export interface QuotaWindow {
  /** `5h`, `7d`, or a provider's own name for another window. */
  readonly name: string
  /** 0 to 1. */
  readonly utilization: number
  /** Epoch ms. */
  readonly resetAt?: number
}

/** Why an account cannot take a request now, and until when (epoch ms). */
export interface QuotaRefusal {
  readonly kind: "usage-limit" | "rate-limit" | "unauthorized" | "signin"
  readonly until?: number
}

export interface QuotaReading {
  readonly at: number
  readonly status?: QuotaStatus
  readonly windows: ReadonlyArray<QuotaWindow>
  readonly refusal?: QuotaRefusal
}

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

const REFUSALS = new Set(["usage-limit", "rate-limit", "unauthorized", "signin"])
const STATUSES = new Set(["allowed", "allowed_warning", "rejected"])
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/**
 * A reading from another plugin, checked field by field: RPC output is
 * untyped JSON. Anything malformed is dropped, never trusted.
 */
export function asReading(value: unknown): QuotaReading | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!finite(record.at) || !Array.isArray(record.windows)) return undefined
  const windows: QuotaWindow[] = []
  for (const entry of record.windows as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue
    const window = entry as Record<string, unknown>
    if (typeof window.name !== "string" || !finite(window.utilization)) continue
    windows.push({
      name: window.name,
      utilization: Math.min(Math.max(window.utilization, 0), 1),
      ...(finite(window.resetAt) ? { resetAt: window.resetAt } : {}),
    })
  }
  const refusal = record.refusal as Record<string, unknown> | undefined
  const status = typeof record.status === "string" && STATUSES.has(record.status) ? record.status : undefined
  return {
    at: record.at,
    ...(status === undefined ? {} : { status: status as QuotaStatus }),
    windows,
    ...(refusal && typeof refusal.kind === "string" && REFUSALS.has(refusal.kind)
      ? {
          refusal: {
            kind: refusal.kind as QuotaRefusal["kind"],
            ...(finite(refusal.until) ? { until: refusal.until } : {}),
          },
        }
      : {}),
  }
}
