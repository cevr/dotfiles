export type ShellFact =
  | { type: "registered"; owner: string; shellID: string }
  | { type: "exit"; shellID: string; at: number }
  | { type: "admitted"; owner: string; shellID: string }
  | { type: "deleted"; owner: string }
  | { type: "execution"; owner: string; seq: number; at: number; failed: boolean }

export interface ShellExitRead {
  readonly failureAt: number
  readonly undeterminedAt: number
}
export const noShellExit: ShellExitRead = { failureAt: NaN, undeterminedAt: NaN }

/** A live, ordered read for the TUI. Neither an empty inbox nor transcript history resolves an exit. */
export const shellExits = (owns: (id: string) => boolean) => {
  const owners = new Map<string, string>()
  const closed = new Set<string>()
  const execution = new Map<string, { seq: number; failureAt: number }>()
  const exits = new Map<string, { owner: string; at: number }>()
  const clear = (owner: string) => {
    for (const [id, exit] of exits) if (exit.owner === owner) exits.delete(id)
  }
  const exitShell = (id: string, at: number) => {
    const owner = owners.get(id)
    if (!owner) return false
    owners.delete(id)
    closed.add(id)
    if (closed.size > 512) {
      const oldest = closed.values().next()
      if (!oldest.done) closed.delete(oldest.value)
    }
    if (!Number.isFinite(execution.get(owner)?.failureAt) || !Number.isFinite(at)) return false
    exits.set(id, { owner, at })
    return true
  }
  const ordered = (value: Extract<ShellFact, { type: "execution" }>) => {
    if (!owns(value.owner)) return false
    if (value.seq <= Number(execution.get(value.owner)?.seq)) return false
    clear(value.owner)
    if (value.failed) execution.set(value.owner, { seq: value.seq, failureAt: value.at })
    else execution.set(value.owner, { seq: value.seq, failureAt: NaN })
    return true
  }
  const ingest = (value: ShellFact): boolean => {
    switch (value.type) {
      case "registered":
        if (!closed.has(value.shellID) && owns(value.owner)) owners.set(value.shellID, value.owner)
        return false
      case "exit":
        return exitShell(value.shellID, value.at)
      case "admitted":
        if (owners.get(value.shellID) === value.owner) owners.delete(value.shellID)
        if (exits.get(value.shellID)?.owner !== value.owner) return false
        return exits.delete(value.shellID)
      case "deleted":
        execution.delete(value.owner)
        clear(value.owner)
        for (const [id, owner] of owners) if (owner === value.owner) owners.delete(id)
        return true
      case "execution":
        return ordered(value)
    }
  }
  const read = (id: string): ShellExitRead => {
    const failureAt = Number(execution.get(id)?.failureAt)
    const exit = exits.values().find((entry) => entry.owner === id)
    return { failureAt, undeterminedAt: Number(exit?.at) }
  }
  return { ingest, read }
}
