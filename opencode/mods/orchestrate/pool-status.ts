// Compact pool quota rows appended to orchestrate `status` and `land` answers:
// Claude, OpenAI, and Antigravity per group (rows only, no prose). Pure.
import { Array as Arr, Match, Option, Schema } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"

const AccountRow = Schema.Struct({
  credentialID: Schema.String,
  hold: Schema.optionalKey(Schema.Struct({ kind: Schema.String, until: Schema.Number })),
  reading: Schema.optionalKey(
    Schema.Struct({
      windows: Schema.Array(
        Schema.Struct({ name: Schema.String, utilization: Schema.Number, resetAt: Schema.optionalKey(Schema.Number) }),
      ),
      absent: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
})
type AccountRow = typeof AccountRow.Type

export const PoolSnapshot = Schema.Record(Schema.String, Schema.Struct({ accounts: Schema.Array(AccountRow) }))
export type PoolSnapshot = typeof PoolSnapshot.Type

export const AntigravitySnapshot = Schema.Struct({ lines: Schema.Array(Schema.String) })
export type AntigravitySnapshot = typeof AntigravitySnapshot.Type

export const decodePools = Schema.decodeUnknownOption(PoolSnapshot)
export const decodeAntigravity = Schema.decodeUnknownOption(AntigravitySnapshot)

const WINDOWS = ["5h", "7d"] as const

const windowSummary = (account: AccountRow): string =>
  Option.match(Option.fromUndefinedOr(account.reading), {
    onNone: () => "5h unknown · 7d unknown",
    onSome: (reading) => {
      const absent = new Set(Option.getOrElse(Option.fromUndefinedOr(reading.absent), () => []).map((w) => w.name))
      return WINDOWS.map((name) =>
        Option.match(Arr.findFirst(reading.windows, (item) => item.name === name), {
          onSome: (window) => `${name} ${Math.round(window.utilization * 100)}%/100% used`,
          onNone: () =>
            Match.value(absent.has(name)).pipe(
              Match.when(true, () => `${name} none`),
              Match.orElse(() => `${name} unknown`),
            ),
        }),
      ).join(" · ")
    },
  })

const accountLines = (pools: PoolSnapshot): ReadonlyArray<string> =>
  Object.entries(pools).flatMap(([pool, entry]) =>
    entry.accounts.map((account) => {
      const state = Option.match(Option.fromUndefinedOr(account.hold), {
        onNone: () => "available",
        onSome: (hold) => `held (${hold.kind}) until ${formatNotificationTime(hold.until)}`,
      })
      return `${pool} / ${account.credentialID} · ${state} · ${windowSummary(account)}`
    }),
  )

/**
 * Pool quota rows for `orchestrate status` and `orchestrate land`:
 * Claude (`anthropic`), OpenAI (`openai`) and Antigravity per group.
 * Returns empty when neither pools nor Antigravity answered (no prose added).
 */
export const poolStatusRows = (
  pools: Option.Option<PoolSnapshot>,
  antigravity: Option.Option<AntigravitySnapshot>,
): ReadonlyArray<string> => {
  const accounts = Option.match(pools, { onNone: () => Arr.empty<string>(), onSome: accountLines })
  const agy = Option.match(antigravity, { onNone: () => Arr.empty<string>(), onSome: (snap) => snap.lines })
  return [...accounts, ...agy]
}
