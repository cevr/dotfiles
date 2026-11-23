import { Option, Schema } from "effect"
import type { ShellFact } from "../opencode/shell-exits.ts"

const Ref = { sessionID: Schema.NonEmptyString }
const ShellID = { shellID: Schema.NonEmptyString }
const Execution = Schema.Literals(["session.execution.started", "session.execution.failed", "session.execution.succeeded", "session.execution.interrupted"])
const HostFact = Schema.Union([
  Schema.Struct({ type: Execution, created: Schema.Finite, durable: Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int }), data: Schema.Struct(Ref) }),
  Schema.Struct({ type: Schema.Literal("shell.created"), data: Schema.Struct({ info: Schema.Struct({
    id: Schema.NonEmptyString, metadata: Schema.Struct({ ...Ref, background: Schema.Literal(true) }),
  }) }) }),
  Schema.Struct({ type: Schema.Literal("experimental.job.updated"), data: Schema.Struct({ info: Schema.Struct({
    ...Ref, ...ShellID, kind: Schema.Literal("shell"),
  }) }) }),
  Schema.Struct({ type: Schema.Literal("shell.exited"), created: Schema.Finite, data: Schema.Struct({ id: Schema.NonEmptyString }) }),
  Schema.Struct({ type: Schema.Literal("session.inbox.enqueued"), data: Schema.Struct({ ...Ref, item: Schema.Struct({
    type: Schema.Literal("synthetic"), payload: Schema.Struct({ metadata: Schema.Struct({ ...ShellID, source: Schema.Literal("shell") }) }),
  }) }) }),
  Schema.Struct({ type: Schema.Literal("session.deleted"), data: Schema.Struct(Ref) }),
])
const decode = Schema.decodeUnknownOption(HostFact)

const fact = (event: typeof HostFact.Type): Option.Option<ShellFact> => {
  switch (event.type) {
    case "shell.created":
      return Option.some({ type: "registered", owner: event.data.info.metadata.sessionID, shellID: event.data.info.id })
    case "experimental.job.updated":
      return Option.some({ type: "registered", owner: event.data.info.sessionID, shellID: event.data.info.shellID })
    case "shell.exited":
      return Option.some({ type: "exit", shellID: event.data.id, at: event.created })
    case "session.inbox.enqueued":
      return Option.some({ type: "admitted", owner: event.data.sessionID, shellID: event.data.item.payload.metadata.shellID })
    case "session.deleted":
      return Option.some({ type: "deleted", owner: event.data.sessionID })
    default: {
      const owner = event.data.sessionID
      if (event.durable.aggregateID !== owner) return Option.none()
      return Option.some({ type: "execution", owner, seq: event.durable.seq, at: event.created, failed: event.type === "session.execution.failed" })
    }
  }
}

/** Decode the native listener envelope before it enters the plain row fold. */
export const shellEventOf = Option.flatMap(fact)
export const decodeShellEvent = decode
