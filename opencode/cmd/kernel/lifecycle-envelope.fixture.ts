import { Option, Predicate, type Schema } from "effect"
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
const placement = (type: string, child: string, seq: number, location: Location) => {
  const version = Option.getOrElse(Option.fromUndefinedOr(versionOf.get(type)), () => Number(seq > 0))
  const durable = Option.match(Option.filter(Option.some(version), (value) => value > 0), {
    onNone: () => ({}), onSome: (version) => ({ durable: { aggregateID: child, seq, version } }),
  })
  const where = Option.map(Option.filter(Option.fromUndefinedOr(location), () => !routed.has(type)), (location) => ({ location }))
  return { ...durable, ...Option.getOrElse(where, () => ({})) }
}

// Representative payloads for the native producer paths in the matrix.
// The World supplies scenario values over these defaults, not another envelope.
const payloads = (sessionID: string, directory: string) => ({
  "session.created": { sessionID, parentID: "ses_parent", location: { directory }, projectID: "fixture", slug: "fixture", subpath: "", agent: "worker", title: "Fixture", version: "fixture" },
  "session.deleted": { sessionID },
  "session.revert.committed": { sessionID, to: "msg_fixture" },
  "session.execution.started": { sessionID },
  "session.execution.succeeded": { sessionID },
  "session.execution.failed": { sessionID, error: { type: "provider.content-filter" } },
  "session.execution.interrupted": { sessionID, reason: "user" },
  "session.step.failed": { sessionID, assistantMessageID: "msg_fixture", error: { type: "provider.content-filter" },
    finish: "content-filter", rawFinish: "content_filter", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
  "session.retry.scheduled": { sessionID, assistantMessageID: "msg_fixture", attempt: 2, at: 0, error: { type: "provider.rate-limit" } },
  "session.inbox.enqueued": {
    sessionID, inboxID: "msg_fixture", item: { type: "synthetic", payload: { text: "Fixture", metadata: { source: "shell", shellID: "sh_fixture" } }, delivery: "queue" },
  },
  "session.inbox.delivered": { sessionID, inboxID: "msg_fixture" },
  "session.inbox.cancelled": { sessionID, inboxID: "msg_fixture" },
  "shell.created": { info: { id: "sh_fixture", status: "running", metadata: { sessionID, background: true }, time: { started: 0 } } },
  "shell.exited": { id: "sh_fixture", status: "exited", exit: 0 },
  "shell.deleted": { id: "sh_fixture" },
  "experimental.job.updated": { info: { id: "ses_child", sessionID, kind: "subagent", status: "running", time: { started: 0 } } },
  "permission.asked": { id: "per_fixture", sessionID, action: "fixture", resources: ["fixture"] },
  "permission.replied": { requestID: "per_fixture", sessionID, reply: "once" },
  "form.created": { form: { id: "frm_fixture", sessionID, title: "Fixture", fields: [{ key: "name", type: "string" }] } },
  "form.replied": { id: "frm_fixture", sessionID, answer: { name: "Fixture" } },
  "form.cancelled": { id: "frm_fixture", sessionID },
} satisfies Record<Kind, Schema.JsonObject>)

const payloadOf = new Map<string, Schema.JsonObject>(Object.entries(payloads("ses_fixture", "/scratch")))
const dataAt = (type: string, sessionID: string) => {
  const payload = Option.getOrElse(Option.fromUndefinedOr(payloadOf.get(type)), () => ({ sessionID }))
  if (Object.hasOwn(payload, "sessionID")) return { ...payload, sessionID }
  return payload
}

export const lifecycleEnvelope = (type: string, id: string, created: number, sessionID: string, seq: number, location: Location, fields: Schema.JsonObject = {}) => ({
  type, id, created, ...placement(type, sessionID, seq, location),
  data: { ...dataAt(type, sessionID), ...fields },
})

export const routedDelete = (child: string, aggregate: string, created: number) =>
  lifecycleEnvelope("session.deleted", "evt_routed_delete", created, aggregate, 4, { directory: "/scratch" }, { sessionID: child })

const jsonType = (value: Schema.Json) => {
  if (Array.isArray(value)) return "array"
  if (Predicate.isNull(value)) return "null"
  if (Predicate.isString(value)) return "string"
  if (Predicate.isNumber(value)) return "number"
  if (Predicate.isBoolean(value)) return "boolean"
  return "object"
}
const keyTypes = (record: Schema.JsonObject) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, jsonType(value)]))
export const envelopeFields = (frame: Schema.JsonObject, data: Schema.JsonObject) => ({ header: keyTypes(frame), data: keyTypes(data) })
