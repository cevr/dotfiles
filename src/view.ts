// What `status` and `whoami` print: plain JSON for scripts and the Claude
// mod, and one line per track for people.
import { Option, Schema } from "effect"
import type { Identity } from "./Baton.js"
import * as State from "./domain/state.js"
import type { Run, Track } from "./domain/state.js"

export const TrackView = Schema.Struct({
  track: Schema.String,
  unit: Schema.String,
  step: Schema.String,
  holder: Schema.String,
  round: Schema.Int,
  failures: Schema.Int,
  since: Schema.Int,
  agents: Schema.Array(
    Schema.Struct({ role: Schema.String, name: Schema.String, status: Schema.String }),
  ),
})
export type TrackView = typeof TrackView.Type

export const RunView = Schema.Struct({
  run: Schema.String,
  root: Schema.String,
  orchestrator: Schema.String,
  tracks: Schema.Array(TrackView),
  undelivered: Schema.Array(
    Schema.Struct({
      ref: Schema.Int,
      to: Schema.String,
      state: Schema.String,
      failure: Schema.String,
    }),
  ),
})
export type RunView = typeof RunView.Type

/** Who this pane is; empty fields where they do not apply (the orchestrator has no unit). */
export const IdentityView = Schema.Struct({
  run: Schema.String,
  role: Schema.String,
  root: Schema.String,
  unit: Schema.String,
  track: Schema.String,
  spec: Schema.String,
})
export type IdentityView = typeof IdentityView.Type

export const OpenedView = Schema.Struct({
  track: Schema.String,
  tab: Schema.String,
  seats: Schema.Array(
    Schema.Struct({ name: Schema.String, pane: Schema.String, started: Schema.String }),
  ),
})

const trackView = (run: Run, track: Track): TrackView => ({
  track: track.name,
  unit: track.unit,
  step: track.step.kind,
  holder: track.step.holder,
  round: track.rounds,
  failures: track.failures,
  since: track.step.at,
  agents: State.ROLES.flatMap((role) =>
    Option.toArray(State.agentOf(track, role)).map((agent) => ({
      role,
      name: agent.name,
      status: Option.getOrElse(Option.fromUndefinedOr(run.statuses.get(agent.name)), () =>
        unlisted(run),
      ),
    })),
  ),
})

/** An agent herdr has reported on but no longer lists is gone. */
const unlisted = (run: Run): string =>
  Option.match(run.observedAt, { onNone: () => "unobserved", onSome: () => "gone" })

export const runView = (run: Run): RunView => ({
  run: run.name,
  root: run.root,
  orchestrator: run.orchestrator.name,
  tracks: State.openTracks(run).map((track) => trackView(run, track)),
  undelivered: [...run.messages.values()].flatMap((message) => {
    if (message.delivery.state === "delivered") return []
    return [
      {
        ref: message.ref,
        to: message.to.name,
        state: message.delivery.state,
        failure: Option.getOrElse(message.delivery.failure, () => ""),
      },
    ]
  }),
})

export const identityView = (identity: Identity): IdentityView => {
  const { run } = identity
  if (identity.kind === "orch")
    return { run: run.name, role: "orch", root: run.root, unit: "", track: "", spec: "" }
  const { track, role } = identity.seat
  return {
    run: run.name,
    role,
    root: run.root,
    unit: track.unit,
    track: track.name,
    spec: track.spec,
  }
}

const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))}m`

/** One line per open track: where the baton is, for how long, and who is working. */
export const runText = (view: RunView, now: number): string => {
  const head = `${view.run}  ${view.root}`
  if (view.tracks.length === 0) return `${head}\n  no open tracks`
  const width = Math.max(...view.tracks.map((track) => track.track.length))
  const rows = view.tracks.map((track) => {
    const agents = track.agents.map((agent) => `${agent.role} ${agent.status}`).join(" · ")
    return `  ${track.track.padEnd(width)}  r${track.round}  ${track.step} → ${track.holder}  ${minutes(now - track.since)}  (${agents})`
  })
  const owed = view.undelivered.map((message) =>
    `  #${message.ref} to ${message.to}: ${message.state} ${message.failure}`.trimEnd(),
  )
  return [head, ...rows, ...owed].join("\n")
}
