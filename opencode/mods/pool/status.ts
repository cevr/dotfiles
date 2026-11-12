// The pool's own RPC, which other mods read: orchestrate asks `pace` before a
// new agent starts, the status pane draws `status`, and the status sidebar
// draws `session`, the account one session is on, and `alerts`, the logins
// that need a sign-in and a token endpoint that keeps failing; the cache mod
// reads `logins`, the login each of a session's steps went out on. Orchestrate
// tells it each new agent it `started`; the pool on another host of ours reads
// `report`, this host's recent starts and readings, and the status pane draws
// `fleet`, the peers it reads. The definition is the wire contract, kept byte
// for byte; the schemas below are the shapes its methods answer with. No
// answer carries a secret.
import { Schema } from "effect"
import { QuotaReading, RefusalKind } from "./quota.ts"
import { Claim, Reset } from "./resets.ts"

/** The pool's own RPC: each pooled provider's accounts, holds and readings. No secrets. */
export const POOL_STATUS = {
  id: "dotfiles-opencode.pool",
  methods: {
    pace: {
      input: {
        type: "object",
        properties: { providerID: { type: "string" }, model: { type: "string" }, sessionID: { type: "string" } },
        required: ["providerID"],
      },
      output: { type: "object" },
    },
    status: { input: { type: "object" }, output: { type: "object" } },
    session: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, providerID: { type: "string" } },
        required: ["sessionID"],
      },
      output: { type: "object" },
    },
    alerts: { input: { type: "object" }, output: { type: "object" } },
    logins: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: "object" },
    },
    started: { input: { type: "object", properties: { providerID: { type: "string" } }, required: ["providerID"] }, output: { type: "object" } },
    report: { input: { type: "object" }, output: { type: "object" } },
    fleet: { input: { type: "object" }, output: { type: "object" } },
    resets: { input: { type: "object" }, output: { type: "object" } },
    /** A peer asks for, or releases, an account's claim lease (lease.ts `LeaseMessage`); the answer is a `LeaseAnswer`. */
    lease: { input: { type: "object" }, output: { type: "object" } },
    /** The limit tally (limits.ts `Tally`) and its one line, `{ tally?, line? }`. */
    limits: { input: { type: "object" }, output: { type: "object" } },
    /** Start, end, read or plan a push (push.ts `PushRequest`); the answer is a `PushAnswer`. A peer's `pool_push` forwards here over SSH. */
    push: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const

/** An account refused until `until`, set at `at` (epoch ms). */
export const Hold = Schema.Struct({
  kind: RefusalKind,
  until: Schema.Number,
  at: Schema.Number,
})
export type Hold = typeof Hold.Type

/** One account as the status method reports it. */
export const AccountStatus = Schema.Struct({
  credentialID: Schema.String,
  hold: Schema.optionalKey(Hold),
  reading: Schema.optionalKey(QuotaReading),
  /** USD recorded on it in the window. */
  load: Schema.Number,
  /** Sessions whose run or cache is on it now. */
  live: Schema.Number,
  noRoom: Schema.Boolean,
})
export type AccountStatus = typeof AccountStatus.Type

/** A store outside OpenCode whose logins join a pool: what it lists, and the labels it leaves alone. */
export const SourceStatus = Schema.Struct({
  kind: Schema.Literal("gent"),
  dir: Schema.String,
  accounts: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.Struct({ label: Schema.String, reason: Schema.String })),
})
export type SourceStatus = typeof SourceStatus.Type

/** One pool in the status answer; `sources` only when the pool has any. */
export const PoolEntry = Schema.Struct({
  accounts: Schema.Array(AccountStatus),
  sources: Schema.optionalKey(Schema.Array(SourceStatus)),
})
export type PoolEntry = typeof PoolEntry.Type

/** The status method's answer: each pool by its integration id. */
export const PoolsStatus = Schema.Record(Schema.String, PoolEntry)
export type PoolsStatus = typeof PoolsStatus.Type

/**
 * The session method's question: which account `sessionID` is on, in the pool
 * of `providerID`, or, without one, in the pool its newest request went through.
 */
export const SessionQuery = Schema.Struct({
  sessionID: Schema.String,
  providerID: Schema.optionalKey(Schema.String),
})
export type SessionQuery = typeof SessionQuery.Type

/**
 * The account a session is on: `placed` when its newest primary request went
 * out on it, `next` when it has sent none yet and this is the pool's pick for
 * its first. `label` is the login's name as its store lists it (an OpenCode
 * login's label, a gent account's slot), never a token.
 */
export const SessionAccount = Schema.Struct({
  pool: Schema.String,
  credentialID: Schema.String,
  label: Schema.String,
  on: Schema.Literals(["placed", "next"]),
  hold: Schema.optionalKey(Hold),
  reading: Schema.optionalKey(QuotaReading),
})
export type SessionAccount = typeof SessionAccount.Type

/** The session method's answer: no `account` when the provider is not pooled or the pool has none to name. */
export const SessionAnswer = Schema.Struct({ account: Schema.optionalKey(SessionAccount) })
export type SessionAnswer = typeof SessionAnswer.Type

/** What the token endpoint said when it last failed a trade: its status, `server` and `retry-after`; none when it did not answer. */
export const RefreshCause = Schema.Struct({
  status: Schema.optionalKey(Schema.Number),
  server: Schema.optionalKey(Schema.String),
  retryAfter: Schema.optionalKey(Schema.String),
})
export type RefreshCause = typeof RefreshCause.Type

/**
 * A pooled login whose refresh token the token endpoint refused: it serves
 * nothing until its owner signs in again, with `command`, in the store that
 * holds it. `since` is the first refusal (epoch ms).
 */
export const LostLogin = Schema.Struct({
  pool: Schema.String,
  credentialID: Schema.String,
  label: Schema.String,
  since: Schema.Number,
  command: Schema.String,
})
export type LostLogin = typeof LostLogin.Type

/**
 * An outside store none of whose refreshes has gone through for a sustained
 * while: every trade since `since` failed as unavailable, the last at
 * `lastAt`, the endpoint's last word `cause`.
 */
export const RefreshOutage = Schema.Struct({
  pool: Schema.String,
  dir: Schema.String,
  since: Schema.Number,
  lastAt: Schema.Number,
  failures: Schema.Number,
  cause: Schema.optionalKey(RefreshCause),
})
export type RefreshOutage = typeof RefreshOutage.Type

/** The alerts method's answer: every pool's lost logins and refresh outages. No token. */
export const Alerts = Schema.Struct({
  lost: Schema.Array(LostLogin),
  outages: Schema.Array(RefreshOutage),
})
export type Alerts = typeof Alerts.Type

/** The logins method's question: the login each step of `sessionID` went out on. */
export const LoginsQuery = Schema.Struct({ sessionID: Schema.String })
export type LoginsQuery = typeof LoginsQuery.Type

/**
 * One priced step of a session: the assistant message it wrote and the login
 * (credential id, never a token) its request went out on, in the pool `pool`.
 */
export const StepLogin = Schema.Struct({
  pool: Schema.String,
  messageID: Schema.String,
  credentialID: Schema.String,
})
export type StepLogin = typeof StepLogin.Type

/**
 * The logins method's answer: each step of the session the pools recorded in
 * their window, oldest first. A step from before the pool named its message is
 * left out.
 */
export const SessionLogins = Schema.Struct({ steps: Schema.Array(StepLogin) })
export type SessionLogins = typeof SessionLogins.Type

/** The started method's question: a new agent was admitted on `providerID`. */
export const StartedQuery = Schema.Struct({ providerID: Schema.String })
export type StartedQuery = typeof StartedQuery.Type

/** A new agent admitted on `providerID` at `at` (epoch ms). */
export const Start = Schema.Struct({ providerID: Schema.String, at: Schema.Number })
export type Start = typeof Start.Type

/** A reading of one login of the pool `pool`, as the host that took it holds it. */
export const SharedReading = Schema.Struct({ pool: Schema.String, credentialID: Schema.String, reading: QuotaReading })
export type SharedReading = typeof SharedReading.Type

/**
 * The report method's answer, what a peer host reads of this one: the agents
 * it admitted in the last few minutes (their spend may not show in a reading
 * yet) and its newest readings, at `at` on `host`. Never a token.
 */
export const Report = Schema.Struct({
  host: Schema.String,
  at: Schema.Number,
  starts: Schema.Array(Start),
  readings: Schema.Array(SharedReading),
  /** The tokens the host sent on each open row of the limit tally (limits.ts), from a host that keeps one. */
  limits: Schema.optionalKey(
    Schema.Struct({
      since: Schema.Number,
      rows: Schema.Array(
        Schema.Struct({ key: Schema.String, sums: Schema.Record(Schema.String, Schema.Struct({ w: Schema.Number, raw: Schema.Number })) }),
      ),
    }),
  ),
})
export type Report = typeof Report.Type

/**
 * One peer host as the fleet method reports it: the host its last report came
 * from and when, the agents it admitted that still count, and, while it cannot
 * be read, since when and why.
 */
export const PeerStatus = Schema.Struct({
  name: Schema.String,
  host: Schema.optionalKey(Schema.String),
  seenAt: Schema.optionalKey(Schema.Number),
  starts: Schema.Number,
  missed: Schema.optionalKey(Schema.Struct({ since: Schema.Number, message: Schema.String })),
})
export type PeerStatus = typeof PeerStatus.Type

/** The fleet method's answer: this host, its own starts that still count, and each peer. */
export const FleetStatus = Schema.Struct({
  host: Schema.String,
  starts: Schema.Number,
  settleMinutes: Schema.Number,
  peers: Schema.Array(PeerStatus),
})
export type FleetStatus = typeof FleetStatus.Type

/**
 * The resets method's answer: each hold's reset as it is worked, newest
 * first, and the claims made, newest first; each pool's use-or-lose forecast
 * (push.ts `forecastText`) when a reset would expire unused at the current
 * burn, and each push active on the host (push.ts `pushText`), as lines.
 */
export const ResetsStatus = Schema.Struct({
  resets: Schema.Array(Reset),
  claims: Schema.Array(Claim),
  forecast: Schema.optionalKey(Schema.Array(Schema.String)),
  pushes: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type ResetsStatus = typeof ResetsStatus.Type
