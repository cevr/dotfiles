// When a TUI hands its environment to the subagents of the family it shows.
// The host's TUI sets the environment of the session on screen only; every
// other session's shells fall back to the server's, which names no pane (or,
// before this mod, the pane the server happened to start in). A subagent gets
// the TUI's environment when it first appears and each time it starts to run
// again: the server keeps session environments in memory, so a restart loses
// them, and a subagent the restart resumes starts to run again.

/** One member of the family as the TUI sees it: its id, and whether it runs now. */
export interface Member {
  readonly id: string
  readonly running: boolean
}

/** What the TUI saw at its last look: each member's id and whether it ran. */
export type Seen = ReadonlyMap<string, boolean>

/** The members whose environment is due now, and what the TUI has seen after this look. */
export interface Look {
  readonly due: ReadonlyArray<string>
  readonly seen: Seen
}

/** The first look: nothing seen. */
export const nothingSeen: Seen = new Map()

/**
 * The members due at this look: each one not seen before, and each one that
 * runs now and did not at the last look. A member gone from the family is
 * forgotten, so if it comes back it is due again.
 */
export const look = (seen: Seen, members: ReadonlyArray<Member>): Look => ({
  due: members
    .values()
    .filter((member) => !seen.has(member.id) || (member.running && seen.get(member.id) === false))
    .map((member) => member.id)
    .toArray(),
  seen: new Map(members.map((member) => [member.id, member.running])),
})
