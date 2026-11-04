// One provider's logins as one pool, keyed by its integration (PoolId): which
// accounts it has, which are held and why, the readings and priced steps
// placement reads, and where each session's run and cache are.
//
// The holds, readings and steps are its ledger: the next process reads them
// back (Ledger.external.ts). Pins, caches and placements are this process's own.
import { Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { Mark, placedKey, Step, stepIdentity } from "../Accounts.ts"
import { Hold } from "../PoolStatus.ts"
import { QuotaReading } from "../Quota.ts"
import * as ListLogins from "./ListLogins.command.ts"
import * as PlaceRequest from "./PlaceRequest.command.ts"
import * as PruneLedger from "./PruneLedger.command.ts"
import * as RecordStep from "./RecordStep.command.ts"
import * as RefuseRequest from "./RefuseRequest.command.ts"
import * as ReleaseRun from "./ReleaseRun.command.ts"
import * as TakeReading from "./TakeReading.command.ts"

export const AccountPoolState = Schema.Struct({
  /** Accounts in pool order: the provider's logins, as its integration lists them, then each outside store's. */
  credentials: Schema.Array(Schema.String),
  holds: Schema.Record(Schema.String, Hold),
  readings: Schema.Record(Schema.String, QuotaReading),
  /** Priced steps in the window, oldest first. */
  steps: Schema.Array(Step),
  /** The pin of each running session. */
  runs: Schema.Record(Schema.String, Mark),
  /** Where each session last sent a request: its cache lives there for a while. */
  recent: Schema.Record(Schema.String, Mark),
  /** The account each session's newest request of each kind went out on, by `sessionID:kind`. */
  placed: Schema.Record(Schema.String, Schema.String),
})
export type AccountPoolState = typeof AccountPoolState.Type

/** The part of the state the ledger keeps between processes. */
export type LedgerState = Pick<AccountPoolState, "holds" | "readings" | "steps">

export const empty: AccountPoolState = { credentials: [], holds: {}, readings: {}, steps: [], runs: {}, recent: {}, placed: {} }

/** A pool that starts from the ledger a previous process wrote. */
export const restored = (ledger: LedgerState): AccountPoolState => ({
  ...empty,
  holds: ledger.holds,
  readings: ledger.readings,
  steps: [...ledger.steps].sort((left, right) => left.at - right.at),
})

export type Command =
  | ListLogins.ListLogins
  | PlaceRequest.PlaceRequest
  | TakeReading.TakeReading
  | RefuseRequest.RefuseRequest
  | RecordStep.RecordStep
  | ReleaseRun.ReleaseRun
  | PruneLedger.PruneLedger
export type Event =
  | ListLogins.LoginsListed
  | PlaceRequest.RequestPlaced
  | TakeReading.ReadingTaken
  | RefuseRequest.RequestRefused
  | RecordStep.StepRecorded
  | ReleaseRun.RunReleased
  | PruneLedger.LedgerPruned
export type Rejection = PlaceRequest.NoAccount

const without = <A>(record: Readonly<Record<string, A>>, keys: ReadonlyArray<string>): Record<string, A> => {
  const drop = new Set(keys)
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)))
}

export const AccountPool: Decider<AccountPoolState, Command, Event, Rejection> = {
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "ListLogins":
        return ListLogins.decide(state, command)
      case "PlaceRequest":
        return PlaceRequest.decide(state, command, now)
      case "TakeReading":
        return TakeReading.decide(state, command, now)
      case "RefuseRequest":
        return RefuseRequest.decide(state, command, now)
      case "RecordStep":
        return RecordStep.decide(state, command, now)
      case "ReleaseRun":
        return ReleaseRun.decide(state, command)
      case "PruneLedger":
        return PruneLedger.decide(state, command, now)
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "LoginsListed":
        return { ...state, credentials: event.credentials }
      case "RequestPlaced": {
        const mark = { credentialID: event.credentialID, at: event.at }
        return {
          ...state,
          runs: { ...state.runs, [event.sessionID]: mark },
          recent: { ...state.recent, [event.sessionID]: mark },
          placed: { ...state.placed, [placedKey(event.sessionID, event.kind)]: event.credentialID },
        }
      }
      case "ReadingTaken":
        return {
          ...state,
          readings: { ...state.readings, [event.credentialID]: event.reading },
          ...(event.hold === undefined ? {} : { holds: { ...state.holds, [event.credentialID]: event.hold } }),
        }
      case "RequestRefused":
        return { ...state, holds: { ...state.holds, [event.credentialID]: event.hold } }
      case "StepRecorded":
        return {
          ...state,
          steps: [...state.steps, event.step],
          recent: { ...state.recent, [event.step.sessionID]: { credentialID: event.step.credentialID, at: event.step.at } },
        }
      case "RunReleased":
        return { ...state, runs: without(state.runs, [event.sessionID]) }
      case "LedgerPruned": {
        const pruned = new Set(event.steps.map(stepIdentity))
        return {
          ...state,
          steps: state.steps.filter((step) => !pruned.has(stepIdentity(step))),
          holds: without(state.holds, event.holds),
          runs: without(state.runs, event.runs),
          recent: without(state.recent, event.caches),
        }
      }
    }
  },
}
