// The Fleet aggregate's stories: this host records the agents it admits, takes
// each peer's newest report, records a peer that stops answering once, and its
// pace counts every start in the fleet until it settles.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import * as Story from "@dotfiles/decider/story"
import {
  type Event,
  ClaimPoll,
  Fleet,
  inflight,
  KEEP_MS,
  MissPeer,
  ownStarts,
  PeerMissed,
  PeerReported,
  peers,
  PollClaimed,
  RecordStart,
  report,
  StartRecorded,
  StartsExpired,
  TakeReport,
} from "./fleet.ts"
import type { Report } from "./status.ts"

const MINUTE = 60_000
const T0 = 1_800_000_000_000
const SETTLE = 10 * MINUTE

const story = Story.make(Fleet)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const workbox = (at: number, starts: Report["starts"] = []): Report => ({ host: "bite-cristian", at, starts, readings: [] })

describe("Fleet", () => {
  test("records each agent this host admits, at the time it was admitted", () =>
    run(
      Story.clock(T0),
      Story.when(RecordStart.make({ providerID: "anthropic" })),
      Story.then(StartRecorded.make({ start: { providerID: "anthropic", at: T0 } })),
      Story.state({ starts: [{ providerID: "anthropic", at: T0 }], peers: {} }),
    ))

  test("takes a peer's newer report and ignores an older or the same one", () =>
    run(
      Story.clock(T0),
      Story.when(TakeReport.make({ peer: "workbox", report: workbox(T0 - 1000) })),
      Story.then(PeerReported.make({ peer: "workbox", report: workbox(T0 - 1000), at: T0 })),
      Story.when(TakeReport.make({ peer: "workbox", report: workbox(T0 - 1000) })),
      Story.then(),
      Story.when(TakeReport.make({ peer: "workbox", report: workbox(T0 - 5000) })),
      Story.then(),
    ))

  test("records a peer that stops answering once, keeps its last report, and takes it back when it answers", () =>
    run(
      Story.given(PeerReported.make({ peer: "workbox", report: workbox(T0 - 1000), at: T0 - 1000 })),
      Story.clock(T0),
      Story.when(MissPeer.make({ peer: "workbox", message: "ssh: connect timed out" })),
      Story.then(PeerMissed.make({ peer: "workbox", at: T0, message: "ssh: connect timed out" })),
      Story.when(MissPeer.make({ peer: "workbox", message: "ssh: connect timed out" })),
      Story.then(),
      Story.state({
        starts: [],
        peers: { workbox: { report: workbox(T0 - 1000), seenAt: T0 - 1000, missed: { since: T0, message: "ssh: connect timed out" } } },
      }),
      // The same report as before still clears the miss: the peer answers again.
      Story.when(TakeReport.make({ peer: "workbox", report: workbox(T0 - 1000) })),
      Story.then(PeerReported.make({ peer: "workbox", report: workbox(T0 - 1000), at: T0 })),
      Story.state({ starts: [], peers: { workbox: { report: workbox(T0 - 1000), seenAt: T0 } } }),
    ))

  test("forgets this host's starts after an hour, when the next one is recorded", () =>
    run(
      Story.given(StartRecorded.make({ start: { providerID: "anthropic", at: T0 } })),
      Story.clock(T0 + KEEP_MS - 1),
      Story.when(RecordStart.make({ providerID: "anthropic" })),
      Story.then(StartRecorded.make({ start: { providerID: "anthropic", at: T0 + KEEP_MS - 1 } })),
      Story.clock(T0 + KEEP_MS + 1),
      Story.when(RecordStart.make({ providerID: "openai" })),
      Story.then<Event>(StartRecorded.make({ start: { providerID: "openai", at: T0 + KEEP_MS + 1 } }), StartsExpired.make({ before: T0 + 1 })),
      Story.state({
        starts: [
          { providerID: "anthropic", at: T0 + KEEP_MS - 1 },
          { providerID: "openai", at: T0 + KEEP_MS + 1 },
        ],
        peers: {},
      }),
    ))

  test("lets one of the host's instances read a peer at a time: a peer read lately is not read again", () =>
    run(
      Story.clock(T0),
      Story.when(ClaimPoll.make({ peer: "workbox", everyMs: 15_000 })),
      Story.then(PollClaimed.make({ peer: "workbox", at: T0 })),
      Story.clock(T0 + 14_999),
      Story.when(ClaimPoll.make({ peer: "workbox", everyMs: 15_000 })),
      Story.then(),
      // Another peer is its own claim.
      Story.when(ClaimPoll.make({ peer: "laptop", everyMs: 15_000 })),
      Story.then(PollClaimed.make({ peer: "laptop", at: T0 + 14_999 })),
      Story.clock(T0 + 15_000),
      // A report keeps when the peer was asked.
      Story.when(TakeReport.make({ peer: "workbox", report: workbox(T0) })),
      Story.then(PeerReported.make({ peer: "workbox", report: workbox(T0), at: T0 + 15_000 })),
      Story.when(ClaimPoll.make({ peer: "workbox", everyMs: 15_000 })),
      Story.then(PollClaimed.make({ peer: "workbox", at: T0 + 15_000 })),
      Story.state({
        starts: [],
        peers: { workbox: { report: workbox(T0), seenAt: T0 + 15_000, polledAt: T0 + 15_000 }, laptop: { polledAt: T0 + 14_999 } },
      }),
    ))
})

describe("the fleet's starts", () => {
  const state = fold(Fleet, [
    StartRecorded.make({ start: { providerID: "anthropic", at: T0 - 12 * MINUTE } }),
    StartRecorded.make({ start: { providerID: "anthropic", at: T0 - 2 * MINUTE } }),
    PeerReported.make({
      peer: "workbox",
      report: workbox(T0 - MINUTE, [
        { providerID: "openai", at: T0 - 3 * MINUTE },
        { providerID: "anthropic", at: T0 - 11 * MINUTE },
        // A clock far ahead of this one's: not counted.
        { providerID: "anthropic", at: T0 + 5 * MINUTE },
      ]),
      at: T0 - MINUTE,
    }),
    PeerMissed.make({ peer: "laptop", at: T0 - MINUTE, message: "no route to host" }),
  ])

  test("count this host's and every peer's starts within the settle time", () => {
    expect(inflight(state, T0, SETTLE)).toEqual([
      { providerID: "anthropic", at: T0 - 2 * MINUTE },
      { providerID: "openai", at: T0 - 3 * MINUTE },
    ])
    expect(ownStarts(state, T0, SETTLE)).toEqual([{ providerID: "anthropic", at: T0 - 2 * MINUTE }])
  })

  test("a report carries only this host's own starts, never a peer's, so no start counts twice", () => {
    expect(report(state, "mac", T0, SETTLE, [])).toEqual({
      host: "mac",
      at: T0,
      starts: [{ providerID: "anthropic", at: T0 - 2 * MINUTE }],
      readings: [],
    })
  })

  test("the pane's rows name each peer's host, its starts that count and since when it is missed", () => {
    expect(peers(state, ["workbox", "laptop", "studio"], T0, SETTLE)).toEqual([
      { name: "workbox", host: "bite-cristian", seenAt: T0 - MINUTE, starts: 1 },
      { name: "laptop", starts: 0, missed: { since: T0 - MINUTE, message: "no route to host" } },
      { name: "studio", starts: 0 },
    ])
  })
})
