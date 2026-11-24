/** Owner RPC stand-in for TUI-only journeys. It samples the simulated HTTP
 * host directly; no TUI data, fabricated event or second reader join. */
import { Option, Schema } from "effect"
import { Phase } from "../mods/kernel/child-lifecycle.ts"
import { RowFact } from "../mods/kernel/child-row.ts"
import { CHILD_ROWS, type RowsReply } from "../mods/kernel/opencode/child-row.ts"
import { MarkRead } from "../mods/wake/latch.ts"
import type { Double, Rpc } from "../sim-tui/server.ts"

const read = Schema.decodeUnknownOption(Schema.Struct({ children: Schema.Array(Schema.String) }))
const ended = Schema.is(Phase.cases.Settled.fields.outcome)
const clockOf = (phase: Phase, time: { readonly busy?: number; readonly idle?: number; readonly created: number }) => {
  const fallback = () => time.created
  if (phase._tag === "Settled") return Option.getOrElse(Option.fromUndefinedOr(time.idle), fallback)
  return Option.getOrElse(Option.fromUndefinedOr(time.busy), fallback)
}

export const fixtureChildRows = () => {
  let source = Option.none<Double>()
  const history = new Map<string, { readonly phase: string; readonly at: number; readonly revision: number }>()
  const row = (child: string, server: Double) => Option.map(server.info(child), ({ time, outcome }) => {
    let phase: Phase = Phase.cases.Unknown.make({})
    if (server.running(child)) phase = Phase.cases.Running.make({})
    else if (ended(outcome)) phase = Phase.cases.Settled.make({ outcome, cause: "Unknown" })
    const at = clockOf(phase, time)
    const prior = history.get(child)
    let revision = Option.getOrElse(Option.map(Option.fromUndefinedOr(prior), ({ revision }) => revision + 1), () => 1)
    if (prior && prior.phase === phase._tag && prior.at === at) revision = prior.revision
    history.set(child, { phase: phase._tag, at, revision })
    return {
      child, at, mark: MarkRead.cases.Unreadable.make({}), fact: RowFact.cases.NoFact.make({}),
      observation: { version: 1 as const, child, revision, basis: "current" as const, phase },
    }
  })
  const rpc: Rpc = (call) => {
    if (call.rpcID !== CHILD_ROWS.id || call.method !== "read") return Option.none()
    return Option.map(read(call.input), ({ children }): RowsReply => ({
      rows: children.flatMap((child) => Option.toArray(Option.flatMap(source, (server) => row(child, server)))),
    }))
  }
  return { rpc, attach: (server: Double) => { source = Option.some(server) } }
}
