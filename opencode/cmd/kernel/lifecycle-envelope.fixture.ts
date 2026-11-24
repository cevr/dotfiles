import { Option } from "effect"
import type { lifecycleEventTypes } from "../../mods/kernel/lifecycle-event-types.ts"

type Kind = typeof lifecycleEventTypes[number]
type Location = { readonly directory: string; readonly workspaceID?: string }
const versions = {
  "session.created": 1, "session.deleted": 2, "session.revert.committed": 1,
  "session.execution.started": 1, "session.execution.succeeded": 1,
  "session.execution.failed": 1, "session.execution.interrupted": 1,
  "session.step.failed": 1, "session.retry.scheduled": 1,
  "session.inbox.enqueued": 1, "session.inbox.delivered": 1, "session.inbox.cancelled": 1,
  "shell.created": 0, "shell.exited": 0, "shell.deleted": 0, "experimental.job.updated": 0,
  "permission.asked": 0, "permission.replied": 0,
  "form.created": 0, "form.replied": 0, "form.cancelled": 0,
} satisfies Record<Kind, number>

const versionOf = new Map(Object.entries(versions))
// Unlocated paths are threaded through the pin's session routes, not a
// fabricated envelope location. The native matrix checks this inventory.
const routed = new Set([
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.deleted", "session.revert.committed", "session.inbox.cancelled",
])
export const placement = (type: string, child: string, seq: number, location?: Location) => {
  const version = Option.getOrElse(Option.fromUndefinedOr(versionOf.get(type)), () => Number(seq > 0))
  const durable = Option.match(Option.filter(Option.some(version), (value) => value > 0), {
    onNone: () => ({}), onSome: (version) => ({ durable: { aggregateID: child, seq, version } }),
  })
  const where = Option.map(Option.filter(Option.fromUndefinedOr(location), () => !routed.has(type)), (location) => ({ location }))
  return { ...durable, ...Option.getOrElse(where, () => ({})) }
}

export const routedDelete = (child: string, aggregate: string, created: number) => ({
  type: "session.deleted", id: "evt_routed_delete", created, data: { sessionID: child },
  ...placement("session.deleted", aggregate, 4),
})
