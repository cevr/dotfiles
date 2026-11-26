// One line for the whole fleet (the pace-hit diagnosis, 2026-11-26, law 1).
//
// Each login's line is built from claim records: a claim, its observation and
// the requests admitted on the room it gave back (resets.ts `pacePlans`).
// Those used to live only in the resets store of the host that made them, so
// on the same readings the workbox held a login the Mac admitted. Now each
// host sends its own records in the peer report (status.ts `PlanRecords`), and
// every host builds every line from the fleet's merged records: on the same
// readings, every host gives the same answer.
//
// A peer that cannot be read (no report, a missed read, a report older than
// PLANS_FRESH_MS, or a host too old to send its records) may hold records this
// host lacks. A claim it lacks only lowers the line here (a claim only adds,
// weekly-pace.ts `lineOf`), but a request it admitted on a known claim's room
// would leave that room looser here than on the peer. So while any peer cannot
// be read, no claim's room is lent (`PacePlan.rebase.withheld`): the requests
// known still count as spent, and the line is the week's own. This host is then
// never looser than the shared line, and the status says which line is in force.
import { Array as Arr, Match, Option, Order, Record as Rec, Schema } from "effect"
import { Claim, pacePlans, type ResetProvider, type Spend } from "./resets.ts"
import type { AccountStatus, PlanRecords } from "./status.ts"
import { lineOf, ordinaryPlan, type PacePlan } from "./weekly-pace.ts"

/** A peer's records count as current while its report came within this long (the fleet polls every 30 s). */
export const PLANS_FRESH_MS = 10 * 60_000

/** One peer as the line reads it: its last report's records, if it sent any, and whether that report is current. */
export interface PeerPlans {
  readonly name: string
  readonly records: Option.Option<PlanRecords>
  readonly current: boolean
}

/** The line is the fleet's: every peer's records are current and merged. */
export const Shared = Schema.TaggedStruct("shared", { peers: Schema.Array(Schema.String) })
/** A peer cannot be read: this host's known records, with no claim's room lent. */
export const Withheld = Schema.TaggedStruct("withheld", { unread: Schema.Array(Schema.String) })
/** Which line is in force. */
export const LineSource = Schema.Union([Shared, Withheld])
export type LineSource = typeof LineSource.Type

/** A resets store's records as the line reads them: its claims and reservations. */
export const recordsOf = (state: { readonly claims: ReadonlyArray<Claim>; readonly spends?: ReadonlyArray<Spend> }): PlanRecords => ({
  claims: state.claims,
  spends: Option.getOrElse(Option.fromUndefinedOr(state.spends), () => []),
})

const sameClaim = Schema.toEquivalence(Claim)
const byClaim = Order.combineAll<Claim>([
  Order.mapInput(Order.Number, (claim) => claim.at),
  Order.mapInput(Order.String, (claim) => claim.key),
  Order.mapInput(Order.String, (claim) => claim.requestID),
])
const bySpend = Order.combineAll<PlanRecords["spends"][number]>([
  Order.mapInput(Order.Number, (spend) => spend.at),
  Order.mapInput(Order.String, (spend) => spend.id),
])

/**
 * The fleet's records: every host's, each record once, in one order whatever
 * host holds which (claims oldest first, ties by key), so two hosts holding the
 * same records in any split build the same lines.
 */
export const mergeRecords = (all: ReadonlyArray<PlanRecords>): PlanRecords => {
  const claims = Arr.dedupeWith(Arr.sort(all.flatMap((records) => records.claims), byClaim), sameClaim)
  const spends = Arr.dedupeWith(Arr.sort(all.flatMap((records) => records.spends), bySpend), (left: Spend, right: Spend) => left.id === right.id)
  return { claims, spends }
}

/** The account-wide week of an account's reading. */
const weekOf = (account: AccountStatus) =>
  Arr.findFirst(Option.match(Option.fromUndefinedOr(account.reading), { onNone: () => [], onSome: (reading) => reading.windows }), (window) => window.name === "7d")

/**
 * A claim's room, not lent while a peer cannot be read. Where the claim's line
 * is above the week's own, the unread peer may have admitted requests on it up
 * to that line (its reservations fit only within it), so the login counts as
 * used up to it: a request the peer admitted unseen never leaves room here.
 * Where it is not above, no host lends on it, and the known requests count.
 */
const withhold = (plans: Readonly<Record<string, PacePlan>>, accounts: ReadonlyArray<AccountStatus>, now: number): Readonly<Record<string, PacePlan>> =>
  Rec.map(plans, (plan, id): PacePlan => Option.match(Option.fromUndefinedOr(plan.rebase), {
    onNone: () => plan,
    onSome: (rebase) => {
      const known = Option.getOrElse(Option.fromUndefinedOr(rebase.spent), () => 0)
      const lent = Arr.findFirst(accounts, (account) => account.credentialID === id).pipe(
        Option.flatMap(weekOf),
        Option.flatMap((week) => Option.map(Option.fromUndefinedOr(week.resetAt), (resetAt) => ({ resetAt, reading: week.utilization }))),
        Option.map(({ resetAt, reading }) => ({ claimed: lineOf(resetAt, now, plan), own: lineOf(resetAt, now, ordinaryPlan(plan)), reading })),
        Option.filter(({ claimed, own }) => claimed > own + 1e-12),
        Option.map(({ claimed, reading }) => claimed - Math.min(rebase.from, reading)),
      )
      const spent = Math.max(known, Option.getOrElse(lent, () => 0))
      return { ...plan, rebase: { ...rebase, spent, withheld: true } }
    },
  }))

/** The fleet's merged records and which line is in force. */
export interface FleetRecords {
  readonly records: PlanRecords
  readonly source: LineSource
}

/** Every login's line and which line is in force. */
export interface FleetLine {
  readonly plans: Readonly<Record<string, PacePlan>>
  readonly source: LineSource
}

/** The records this host builds lines from: its own and every peer's last report's, and which line is in force. */
export const fleetRecords = (own: PlanRecords, peers: ReadonlyArray<PeerPlans>): FleetRecords => {
  const unread = peers.flatMap((peer) => Arr.filter([peer.name], () => !peer.current || Option.isNone(peer.records)))
  const records = mergeRecords([own, ...peers.flatMap((peer) => Option.toArray(peer.records))])
  return {
    records,
    source: Arr.match(unread, {
      onEmpty: (): LineSource => Shared.make({ peers: peers.map((peer) => peer.name) }),
      onNonEmpty: (names): LineSource => Withheld.make({ unread: names }),
    }),
  }
}

/** Every login's line (`pacePlans`) from the fleet's merged records; while a peer cannot be read, no claim's room is lent. */
export const fleetPlans = (
  provider: ResetProvider,
  accounts: ReadonlyArray<AccountStatus>,
  own: PlanRecords,
  peers: ReadonlyArray<PeerPlans>,
  now: number,
  planCredits = false,
): FleetLine => {
  const { records, source } = fleetRecords(own, peers)
  const plans = pacePlans(provider, accounts, records.claims, now, records.spends, planCredits)
  return {
    plans: Match.value(source).pipe(Match.tagsExhaustive({ shared: () => plans, withheld: () => withhold(plans, accounts, now) })),
    source,
  }
}

/** The status line for the line in force. */
export const lineText = (source: LineSource): string =>
  Match.value(source).pipe(Match.tagsExhaustive({
    shared: ({ peers }) => Arr.match(peers, {
      onEmpty: () => "line: this host's claims (no peers)",
      onNonEmpty: (names) => `line: shared with ${names.join(", ")} (one line for the fleet, from every host's claims)`,
    }),
    withheld: ({ unread }) =>
      `line: ${unread.join(", ")} cannot be read, so no claimed reset's room is lent until it answers; the week's own line holds, never looser than the shared one`,
  }))
