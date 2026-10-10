// A run's state, folded from its log: who holds each track's baton, what
// baton owes each agent (the outbox), and which tracks have stalled. Every
// function here is pure: the same entries give the same run.
import { Array as Arr, Option } from "effect"
import { Event } from "./event.js"
import type { Agent, AgentStatus, Entry, Role, Stall } from "./event.js"

/** Whoever works next: a track's worker, or the orchestrator. */
export type Holder = Role | "orch"

export type StepKind =
  | "building"
  | "review"
  | "fixing"
  | "verifying"
  | "accepted"
  | "stuck"
  | "question"
  | "note"

/** What a track is doing, since which event (`seq`) and when. */
export type Step = {
  readonly kind: StepKind
  readonly holder: Holder
  readonly seq: number
  readonly at: number
}

export type Closure = { readonly at: number; readonly merged: Option.Option<string> }

export type Track = {
  readonly unit: string
  readonly name: string
  readonly cwd: string
  readonly tab: string
  readonly spec: string
  readonly impl: Agent
  readonly rev: Agent
  readonly ver: Option.Option<Agent>
  readonly maxFailures: number
  readonly rounds: number
  readonly failures: number
  readonly request: Option.Option<string>
  readonly step: Step
  readonly closed: Option.Option<Closure>
  /** Since when no agent of the track has been working, by herdr's record. */
  readonly quietSince: Option.Option<number>
}

export type DeliveryState = "pending" | "sending" | "delivered" | "failed"

export type Delivery = {
  readonly state: DeliveryState
  readonly at: number
  readonly failure: Option.Option<string>
}

/** One line baton owes an agent, implied by the event `ref`. */
export type Message = {
  readonly ref: number
  readonly unit: Option.Option<string>
  readonly to: Agent
  readonly text: string
  readonly delivery: Delivery
}

export type Run = {
  readonly name: string
  readonly root: string
  readonly orchestrator: Agent
  readonly tracks: ReadonlyMap<string, Track>
  readonly messages: ReadonlyMap<number, Message>
  /** herdr's last record of the run's agents; an agent it lacks is gone. */
  readonly statuses: ReadonlyMap<string, AgentStatus>
  readonly observedAt: Option.Option<number>
  readonly blockedSince: ReadonlyMap<string, number>
  /** `unit:step:stall` for each stall already reported. */
  readonly alerts: ReadonlySet<string>
  readonly seq: number
}

export const STALL_QUIET_MS = 10 * 60_000
export const STALL_DIALOG_MS = 2 * 60_000
/** A delivery that started and never finished (a crash) is retried after this. */
export const DELIVERY_RETRY_MS = 2 * 60_000

export const ROLES: ReadonlyArray<Role> = ["impl", "rev", "ver"]

export const trackName = (run: string, unit: string): string => `${run}-${unit}`
export const unitDir = (run: Run, unit: string): string => `${run.root}/${unit}`

export const agentOf = (track: Track, role: Role): Option.Option<Agent> => {
  if (role === "impl") return Option.some(track.impl)
  if (role === "rev") return Option.some(track.rev)
  return track.ver
}

const agentsOf = (track: Track): ReadonlyArray<Agent> => [
  track.impl,
  track.rev,
  ...Option.toArray(track.ver),
]

/** Folds a run's log, oldest first. A run's log starts with `RunStarted`. */
export const project = (name: string, entries: ReadonlyArray<Entry>): Option.Option<Run> =>
  Option.flatMap(Arr.head(entries), (first) => {
    const started = first.event
    if (!Event.guards.RunStarted(started)) return Option.none()
    const run: Draft = {
      name,
      root: started.root,
      orchestrator: started.orchestrator,
      tracks: new Map(),
      messages: new Map(),
      statuses: new Map(),
      observedAt: Option.none(),
      blockedSince: new Map(),
      alerts: new Set(),
      seq: 0,
    }
    for (const entry of entries) fold(run, entry)
    return Option.some<Run>(run)
  })

/** The run while it is folded: the same fields, writable. */
type Draft = {
  name: string
  root: string
  orchestrator: Agent
  tracks: Map<string, Track>
  messages: Map<number, Message>
  statuses: Map<string, AgentStatus>
  observedAt: Option.Option<number>
  blockedSince: Map<string, number>
  alerts: Set<string>
  seq: number
}

const fold = (run: Draft, entry: Entry): void => {
  run.seq = entry.seq
  const at = entry.at
  const seq = entry.seq
  const send = (to: Agent, unit: Option.Option<string>, text: string): void => {
    const delivery: Delivery = { state: "pending", at, failure: Option.none() }
    run.messages.set(seq, { ref: seq, unit, to, text, delivery })
  }
  const tag = (unit: string): string => `[${trackName(run.name, unit)}]`
  const toOrch = (unit: string, text: string): void =>
    send(run.orchestrator, Option.some(unit), text)
  const toRole = (track: Track, role: Role, text: string): void => {
    for (const agent of Option.toArray(agentOf(track, role)))
      send(agent, Option.some(track.unit), text)
  }
  const step = (track: Track, kind: StepKind, holder: Holder): Track => ({
    ...track,
    step: { kind, holder, seq, at },
  })
  const update = (unit: string, next: (track: Track) => Track): void => {
    for (const track of Option.toArray(Option.fromUndefinedOr(run.tracks.get(unit))))
      run.tracks.set(unit, next(track))
  }
  /** A failed review or verification: back to the implementor, or stuck at the cap. */
  const failed = (track: Track, file: string, what: string): Track => {
    const failures = track.failures + 1
    if (failures >= track.maxFailures) {
      toOrch(
        track.unit,
        `${tag(track.unit)} stuck: round ${track.rounds} ${what}, failure ${failures} of ${track.maxFailures}: ${file}`,
      )
      return { ...step(track, "stuck", "orch"), failures }
    }
    toRole(track, "impl", `${tag(track.unit)} round ${track.rounds} ${what}: ${file}`)
    return { ...step(track, "fixing", "impl"), failures }
  }
  const stopped = (track: Track, who: string, file: string): Track => {
    toOrch(
      track.unit,
      `${tag(track.unit)} stuck: the ${who} stopped at round ${track.rounds}: ${file}`,
    )
    return step(track, "stuck", "orch")
  }
  const accepted = (track: Track, how: string, file: string): Track => {
    toOrch(track.unit, `${tag(track.unit)} ${how} at round ${track.rounds}: ${file}`)
    return step(track, "accepted", "orch")
  }

  Event.match(entry.event, {
    RunStarted: (event) => {
      run.root = event.root
      run.orchestrator = event.orchestrator
    },
    TrackOpened: (event) => {
      const track: Track = {
        unit: event.unit,
        name: trackName(run.name, event.unit),
        cwd: event.cwd,
        tab: event.tab,
        spec: event.spec,
        impl: event.impl,
        rev: event.rev,
        ver: event.ver,
        maxFailures: event.maxFailures,
        rounds: 0,
        failures: 0,
        request: Option.none(),
        step: { kind: "building", holder: "impl", seq, at },
        closed: Option.none(),
        quietSince: Option.none(),
      }
      run.tracks.set(event.unit, track)
      toRole(
        track,
        "impl",
        `${tag(event.unit)} you hold the baton: build round 1 from ${event.spec}`,
      )
    },
    RoundSubmitted: (event) =>
      update(event.unit, (track) => {
        const rounds = track.rounds + 1
        toRole(
          track,
          "rev",
          `${tag(event.unit)} round ${rounds} ready for review: ${event.request}`,
        )
        return { ...step(track, "review", "rev"), rounds, request: Option.some(event.request) }
      }),
    ReviewFiled: (event) =>
      update(event.unit, (track) => {
        if (event.verdict === "changes") return failed(track, event.findings, "findings")
        if (event.verdict === "stuck") return stopped(track, "reviewer", event.findings)
        if (Option.isNone(track.ver)) return accepted(track, "accepted", event.findings)
        const request = Option.getOrElse(track.request, () => event.findings)
        toRole(track, "ver", `${tag(event.unit)} round ${track.rounds} to verify: ${request}`)
        return step(track, "verifying", "ver")
      }),
    VerificationFiled: (event) =>
      update(event.unit, (track) => {
        if (event.verdict === "fail") return failed(track, event.report, "failed verification")
        if (event.verdict === "stuck") return stopped(track, "verifier", event.report)
        return accepted(track, "accepted and verified", event.report)
      }),
    QuestionAsked: (event) =>
      update(event.unit, (track) => {
        toOrch(event.unit, `${tag(event.unit)} the ${event.by} asks: ${event.note}`)
        return step(track, "question", "orch")
      }),
    NoteSent: (event) =>
      update(event.unit, (track) => {
        toRole(track, event.to, `orch: ${tag(event.unit)} ${event.text}`)
        return step(track, "note", event.to)
      }),
    TrackClosed: (event) =>
      update(event.unit, (track) => ({
        ...track,
        closed: Option.some({ at, merged: event.merged }),
      })),
    AgentsObserved: (event) => observe(run, at, new Map(Object.entries(event.statuses))),
    StallDetected: (event) => {
      run.alerts.add(alertKey(event.unit, event.step, event.stall))
      for (const track of Option.toArray(Option.fromUndefinedOr(run.tracks.get(event.unit))))
        toOrch(
          event.unit,
          `[watchdog] ${track.name}: ${stallText(track, event.stall)}; ` +
            `the baton is with the ${track.step.holder} (${track.step.kind}, round ${track.rounds}). ` +
            `Unit folder: ${unitDir(run, event.unit)}`,
        )
    },
    DeliveryStarted: (event) => mark(run, event.ref, delivery("sending", at, Option.none())),
    RedeliveryRequested: (event) => mark(run, event.ref, delivery("pending", at, Option.none())),
    DeliveryFinished: (event) => {
      if (Option.isNone(event.failure))
        return mark(run, event.ref, delivery("delivered", at, Option.none()))
      mark(run, event.ref, delivery("failed", at, event.failure))
      // The orchestrator hears of every failed message but its own.
      for (const message of Option.toArray(Option.fromUndefinedOr(run.messages.get(event.ref))))
        if (message.to.name !== run.orchestrator.name)
          send(
            run.orchestrator,
            message.unit,
            `[baton] could not deliver #${message.ref} to ${message.to.name}: ${event.failure.value}. ` +
              `Once it can take it: baton redeliver ${message.ref}`,
          )
    },
  })
}

const delivery = (state: DeliveryState, at: number, failure: Option.Option<string>): Delivery => ({
  state,
  at,
  failure,
})

const mark = (run: Draft, ref: number, next: Delivery): void => {
  for (const message of Option.toArray(Option.fromUndefinedOr(run.messages.get(ref))))
    run.messages.set(ref, { ...message, delivery: next })
}

const observe = (run: Draft, at: number, statuses: Map<string, AgentStatus>): void => {
  run.statuses = statuses
  run.observedAt = Option.some(at)
  for (const name of [...run.blockedSince.keys()])
    if (statuses.get(name) !== "blocked") run.blockedSince.delete(name)
  for (const [name, status] of statuses)
    if (status === "blocked" && !run.blockedSince.has(name)) run.blockedSince.set(name, at)
  for (const track of run.tracks.values()) {
    const working = agentsOf(track).some((agent) => statuses.get(agent.name) === "working")
    if (working) run.tracks.set(track.unit, { ...track, quietSince: Option.none() })
    else if (Option.isNone(track.quietSince))
      run.tracks.set(track.unit, { ...track, quietSince: Option.some(at) })
  }
}

const stallText = (track: Track, stall: Stall): string => {
  const holder = holderName(track)
  if (stall === "gone") return `${holder} is gone`
  if (stall === "dialog") return `${holder} sits at a dialog`
  return "every agent has been idle for 10 minutes"
}

const holderName = (track: Track): string => {
  const { holder } = track.step
  if (holder === "orch") return "the orchestrator"
  return Option.match(agentOf(track, holder), {
    onNone: () => holder,
    onSome: (agent) => agent.name,
  })
}

const alertKey = (unit: string, step: number, stall: Stall): string => `${unit}:${step}:${stall}`

export const isOpen = (track: Track): boolean => Option.isNone(track.closed)

export const openTracks = (run: Run): ReadonlyArray<Track> =>
  [...run.tracks.values()].filter(isOpen)

/** The agents herdr should report on: the orchestrator and every open track's. */
export const watchedAgents = (run: Run): ReadonlyArray<Agent> => [
  run.orchestrator,
  ...openTracks(run).flatMap(agentsOf),
]

export type Seat = { readonly track: Track; readonly role: Role }

/** The open track and seat a herdr pane belongs to. */
export const seatOf = (run: Run, pane: string): Option.Option<Seat> =>
  Arr.findFirst(
    openTracks(run).flatMap((track) =>
      ROLES.flatMap((role) => {
        if (!Option.exists(agentOf(track, role), (agent) => agent.pane === pane)) return []
        return [{ track, role }]
      }),
    ),
    () => true,
  )

/** Messages to send now: pending ones, and ones whose sender died mid-send. */
export const deliverable = (run: Run, now: number): ReadonlyArray<Message> =>
  [...run.messages.values()].filter((message) => {
    if (!toLiveAgent(run, message)) return false
    if (message.delivery.state === "pending") return true
    return message.delivery.state === "sending" && now - message.delivery.at >= DELIVERY_RETRY_MS
  })

/** A closed track's workers get nothing more; the orchestrator gets everything. */
const toLiveAgent = (run: Run, message: Message): boolean => {
  if (message.to.name === run.orchestrator.name) return true
  return Option.match(message.unit, {
    onNone: () => true,
    onSome: (unit) => Option.exists(Option.fromUndefinedOr(run.tracks.get(unit)), isOpen),
  })
}

export type Detected = { readonly unit: string; readonly stall: Stall; readonly step: number }

/**
 * Tracks stuck where a worker holds the baton, not yet reported at this step:
 * the holder is gone or at a dialog, or the whole track went quiet with no
 * message on its way to the holder.
 */
export const stalls = (run: Run, now: number): ReadonlyArray<Detected> =>
  openTracks(run).flatMap((track) =>
    Option.toArray(stallOf(run, track, now)).flatMap((stall) => {
      if (run.alerts.has(alertKey(track.unit, track.step.seq, stall))) return []
      return [{ unit: track.unit, stall, step: track.step.seq }]
    }),
  )

const stallOf = (run: Run, track: Track, now: number): Option.Option<Stall> => {
  const { holder } = track.step
  if (holder === "orch" || Option.isNone(run.observedAt)) return Option.none()
  return Option.flatMap(agentOf(track, holder), (agent) => {
    if (!run.statuses.has(agent.name)) return Option.some<Stall>("gone")
    const blocked = Option.fromUndefinedOr(run.blockedSince.get(agent.name))
    if (Option.exists(blocked, (since) => now - since >= STALL_DIALOG_MS))
      return Option.some<Stall>("dialog")
    if (inFlightTo(run, agent)) return Option.none()
    return Option.flatMap(track.quietSince, (since) => {
      if (now - Math.max(since, track.step.at) < STALL_QUIET_MS) return Option.none()
      return Option.some<Stall>("quiet")
    })
  })
}

const inFlightTo = (run: Run, agent: Agent): boolean =>
  [...run.messages.values()].some(
    (message) =>
      message.to.name === agent.name &&
      (message.delivery.state === "pending" || message.delivery.state === "sending"),
  )
