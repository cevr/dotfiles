// The fleet: the other hosts we own that spend the same accounts (this Mac and
// the workbox). A provider's reading is account-wide, but it lags: an agent
// admitted a minute ago has spent next to nothing yet, so a wave of starts on
// one host is invisible to the other's pace until the readings catch up. Each
// host records the agents it admits, reads its peers' reports, and its pace
// counts every start in the fleet that has not settled into a reading yet.
//
// The Fleet decider holds this host's starts and the newest report of each
// peer, or since when and why it cannot be read. OpenCode runs the plugin once
// per directory it serves, so the state is kept where every one of them reads
// it (the FleetStore, in the plugin's storage): a start admitted in one
// project counts on the pace in all of them, and the report a peer reads is
// the host's whole.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { type PeerStatus, Report, type SharedReading, Start } from "./status.ts"

/** How long a start is kept at all; it counts on the pace only for the settle time. */
export const KEEP_MS = 60 * 60_000

/** A peer's report may be stamped this far ahead of this host's clock and still count. */
export const SKEW_MS = 60_000

export const Missed = Schema.Struct({ since: Schema.Number, message: Schema.String })
export type Missed = typeof Missed.Type

/** One peer: its newest report and when it came, or since when it cannot be read, and when it was last asked. */
export const Peer = Schema.Struct({
  report: Schema.optionalKey(Report),
  seenAt: Schema.optionalKey(Schema.Number),
  missed: Schema.optionalKey(Missed),
  polledAt: Schema.optionalKey(Schema.Number),
})
export type Peer = typeof Peer.Type

export const FleetState = Schema.Struct({
  /** The agents this host admitted, oldest first. */
  starts: Schema.Array(Start),
  peers: Schema.Record(Schema.String, Peer),
})
export type FleetState = typeof FleetState.Type

export const empty: FleetState = { starts: [], peers: {} }

// ── RecordStart ──
// This host admitted a new agent on a provider.

export const RecordStart = Schema.TaggedStruct("RecordStart", { providerID: Schema.String })
export interface RecordStart extends Schema.Schema.Type<typeof RecordStart> {}

export const StartRecorded = Schema.TaggedStruct("StartRecorded", { start: Start })
export interface StartRecorded extends Schema.Schema.Type<typeof StartRecorded> {}

/** The starts admitted at or before `before` are forgotten: they settled long ago. */
export const StartsExpired = Schema.TaggedStruct("StartsExpired", { before: Schema.Number })
export interface StartsExpired extends Schema.Schema.Type<typeof StartsExpired> {}

export declare namespace RecordStart {
  export type Rejections = never
}

// ── TakeReport ──
// A peer answered with its report. An older report than the one held changes nothing.

export const TakeReport = Schema.TaggedStruct("TakeReport", { peer: Schema.String, report: Report })
export interface TakeReport extends Schema.Schema.Type<typeof TakeReport> {}

/** The peer's newest report, read at `at`; it can be read again if it could not be. */
export const PeerReported = Schema.TaggedStruct("PeerReported", { peer: Schema.String, report: Report, at: Schema.Number })
export interface PeerReported extends Schema.Schema.Type<typeof PeerReported> {}

export declare namespace TakeReport {
  export type Rejections = never
}

// ── MissPeer ──
// A peer could not be read. Only the first miss of a run is recorded, so the
// host logs the change once; its last report still counts until it settles.

export const MissPeer = Schema.TaggedStruct("MissPeer", { peer: Schema.String, message: Schema.String })
export interface MissPeer extends Schema.Schema.Type<typeof MissPeer> {}

export const PeerMissed = Schema.TaggedStruct("PeerMissed", { peer: Schema.String, at: Schema.Number, message: Schema.String })
export interface PeerMissed extends Schema.Schema.Type<typeof PeerMissed> {}

export declare namespace MissPeer {
  export type Rejections = never
}

// ── ClaimPoll ──
// One of this host's plugin instances means to read a peer. A peer read less
// than `everyMs` ago is not read again, so the instances share the polling.

export const ClaimPoll = Schema.TaggedStruct("ClaimPoll", { peer: Schema.String, everyMs: Schema.Number })
export interface ClaimPoll extends Schema.Schema.Type<typeof ClaimPoll> {}

export const PollClaimed = Schema.TaggedStruct("PollClaimed", { peer: Schema.String, at: Schema.Number })
export interface PollClaimed extends Schema.Schema.Type<typeof PollClaimed> {}

export declare namespace ClaimPoll {
  export type Rejections = never
}

// ── The aggregate ──

export type Command = RecordStart | TakeReport | MissPeer | ClaimPoll
export type Event = StartRecorded | StartsExpired | PeerReported | PeerMissed | PollClaimed

export const Fleet: Decider<FleetState, Command, Event> = {
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "RecordStart": {
        const recorded = StartRecorded.make({ start: { providerID: command.providerID, at: now } })
        const before = now - KEEP_MS
        return Effect.succeed(state.starts.some((start) => start.at <= before) ? [recorded, StartsExpired.make({ before })] : [recorded])
      }
      case "TakeReport": {
        const held = state.peers[command.peer]
        const stale = held?.report !== undefined && held.missed === undefined && command.report.at <= held.report.at
        return Effect.succeed(stale ? [] : [PeerReported.make({ peer: command.peer, report: command.report, at: now })])
      }
      case "MissPeer":
        return Effect.succeed(
          state.peers[command.peer]?.missed === undefined
            ? [PeerMissed.make({ peer: command.peer, at: now, message: command.message })]
            : [],
        )
      case "ClaimPoll": {
        const polledAt = state.peers[command.peer]?.polledAt
        return Effect.succeed(polledAt === undefined || polledAt <= now - command.everyMs ? [PollClaimed.make({ peer: command.peer, at: now })] : [])
      }
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "StartRecorded":
        return { ...state, starts: [...state.starts, event.start] }
      case "StartsExpired":
        return { ...state, starts: state.starts.filter((start) => start.at > event.before) }
      case "PeerReported": {
        const polledAt = state.peers[event.peer]?.polledAt
        const peer = { report: event.report, seenAt: event.at, ...(polledAt === undefined ? {} : { polledAt }) }
        return { ...state, peers: { ...state.peers, [event.peer]: peer } }
      }
      case "PollClaimed":
        return { ...state, peers: { ...state.peers, [event.peer]: { ...state.peers[event.peer], polledAt: event.at } } }
      case "PeerMissed": {
        const { missed: _missed, ...peer } = state.peers[event.peer] ?? {}
        return { ...state, peers: { ...state.peers, [event.peer]: { ...peer, missed: { since: event.at, message: event.message } } } }
      }
    }
  },
}

// ── Reads ──

/** Whether `start` still counts at `now`: admitted within the settle time, and not from a clock too far ahead. */
const unsettled = (start: Start, now: number, settleMs: number) => start.at > now - settleMs && start.at <= now + SKEW_MS

/** This host's own starts that still count. */
export const ownStarts = (state: FleetState, now: number, settleMs: number): ReadonlyArray<Start> =>
  state.starts.filter((start) => unsettled(start, now, settleMs))

/** Every start in the fleet that still counts: this host's and each peer's last report's. */
export const inflight = (state: FleetState, now: number, settleMs: number): ReadonlyArray<Start> => [
  ...ownStarts(state, now, settleMs),
  ...Object.values(state.peers).flatMap((peer) => (peer.report?.starts ?? []).filter((start) => unsettled(start, now, settleMs))),
]

/** What this host answers a peer: its own starts that still count and its readings. */
export const report = (
  state: FleetState,
  host: string,
  now: number,
  settleMs: number,
  readings: ReadonlyArray<SharedReading>,
): Report => ({ host, at: now, starts: ownStarts(state, now, settleMs), readings })

/** Each peer as the pane draws it, in the order `names` lists them. */
export const peers = (state: FleetState, names: ReadonlyArray<string>, now: number, settleMs: number): ReadonlyArray<PeerStatus> =>
  names.map((name) => {
    const peer = state.peers[name]
    return {
      name,
      ...(peer?.report === undefined ? {} : { host: peer.report.host }),
      ...(peer?.seenAt === undefined ? {} : { seenAt: peer.seenAt }),
      starts: (peer?.report?.starts ?? []).filter((start) => unsettled(start, now, settleMs)).length,
      ...(peer?.missed === undefined ? {} : { missed: peer.missed }),
    }
  })
