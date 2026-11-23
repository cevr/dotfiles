import { Option, Schema } from "effect"

const Ref = { sessionID: Schema.String }
const ShellID = { shellID: Schema.String }
const Execution = Schema.Literals(["session.execution.started", "session.execution.failed", "session.execution.succeeded", "session.execution.interrupted"])
const HostFact = Schema.Union([
  Schema.Struct({ type: Execution, created: Schema.Finite, durable: Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int }), data: Schema.Struct(Ref) }),
  Schema.Struct({ type: Schema.Literal("shell.created"), data: Schema.Struct({ info: Schema.Struct({
    id: Schema.String, metadata: Schema.Struct({ ...Ref, background: Schema.Literal(true) }),
  }) }) }),
  Schema.Struct({ type: Schema.Literal("experimental.job.updated"), data: Schema.Struct({ info: Schema.Struct({
    ...Ref, ...ShellID, kind: Schema.Literal("shell"),
  }) }) }),
  Schema.Struct({ type: Schema.Literal("shell.exited"), created: Schema.Finite, data: Schema.Struct({ id: Schema.String }) }),
  Schema.Struct({ type: Schema.Literal("session.inbox.enqueued"), data: Schema.Struct({ ...Ref, item: Schema.Struct({
    type: Schema.Literal("synthetic"), payload: Schema.Struct({ metadata: Schema.Struct({ ...ShellID, source: Schema.Literal("shell") }) }),
  }) }) }),
  Schema.Struct({ type: Schema.Literal("session.deleted"), data: Schema.Struct(Ref) }),
])
export const decodeShellFact = Schema.decodeUnknownOption(HostFact)

export interface ShellExitRead {
  readonly failureAt: Option.Option<number>
  readonly undeterminedAt: Option.Option<number>
}
export const noShellExit: ShellExitRead = { failureAt: Option.none(), undeterminedAt: Option.none() }

/** A live, ordered read for the TUI. Neither an empty inbox nor transcript history resolves an exit. */
export const shellExits = (owns: (id: string) => boolean) => {
  const owners = new Map<string, string>()
  const execution = new Map<string, { seq: number; failedAt?: number }>()
  const exits = new Map<string, { owner: string; at: number }>()
  const clear = (owner: string) => {
    for (const [id, exit] of exits) if (exit.owner === owner) exits.delete(id)
  }
  const register = (id: string, owner: string) => {
    if (owns(owner)) owners.set(id, owner)
  }
  const exitShell = (id: string, at: number) => {
    const owner = Option.fromUndefinedOr(owners.get(id))
    owners.delete(id)
    if (Option.isNone(owner)) return false
    const failure = Option.fromUndefinedOr(execution.get(owner.value)?.failedAt)
    if (Option.isNone(failure)) return false
    exits.set(id, { owner: owner.value, at })
    return true
  }
  const ingest = (value: typeof HostFact.Type): boolean => {
    switch (value.type) {
      case "shell.created":
        register(value.data.info.id, value.data.info.metadata.sessionID)
        return false
      case "experimental.job.updated":
        register(value.data.info.shellID, value.data.info.sessionID)
        return false
      case "shell.exited":
        return exitShell(value.data.id, value.created)
      case "session.inbox.enqueued": {
        const id = value.data.item.payload.metadata.shellID
        if (owners.get(id) === value.data.sessionID) owners.delete(id)
        if (exits.get(id)?.owner !== value.data.sessionID) return false
        return exits.delete(id)
      }
      case "session.deleted": {
        execution.delete(value.data.sessionID)
        clear(value.data.sessionID)
        for (const [id, owner] of owners) if (owner === value.data.sessionID) owners.delete(id)
        return true
      }
      default: {
        const owner = value.data.sessionID
        const { aggregateID, seq } = value.durable
        if (aggregateID !== owner || !owns(owner)) return false
        const previous = execution.get(owner)
        if (previous && previous.seq >= seq) return false
        clear(owner)
        if (value.type === "session.execution.failed") execution.set(owner, { seq, failedAt: value.created })
        else execution.set(owner, { seq })
        return true
      }
    }
  }
  const read = (id: string): ShellExitRead => {
    const failureAt = execution.get(id)?.failedAt
    const exit = exits.values().find((entry) => entry.owner === id)
    return { failureAt: Option.fromUndefinedOr(failureAt), undeterminedAt: Option.fromUndefinedOr(exit?.at) }
  }
  return { ingest, read }
}
