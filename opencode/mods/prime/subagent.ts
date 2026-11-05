// Moving between a session and its subagents, without rendering: which
// session a subagent call opens, the order ←/→ walks, and the words that say
// how to get around, and which subagents work now.
import type { Family } from "@dotfiles/opencode-subagents/family"
import { subagents } from "@dotfiles/opencode-subagents/subagent-row"
import type { ToolPart } from "./session.ts"

/** A session as navigation reads it: its id, its parent, its title, when it was made. */
export type SessionNode = {
  readonly id: string
  readonly parentID?: string | null
  readonly title?: string
  readonly time?: { readonly created: number }
}

/**
 * The child session a subagent call works in. The host's subagent tool
 * reports it as `metadata.sessionID`: live while the call runs (its progress
 * update), and in the final metadata once it returns or fails. Undefined
 * before the call starts its child, or after a restart drops a running
 * call's live metadata.
 */
export function subagentSession(part: ToolPart): string | undefined {
  if (part.state.status === "streaming") return undefined
  const id = part.state.metadata?.sessionID
  return typeof id === "string" && id ? id : undefined
}

/**
 * Every subagent under the root of `sessionID`'s family, depth first and
 * siblings in the order they were started, as the transcript's `Started`
 * rows list them. The host's picker follows its session list, which reorders
 * as sessions update; ←/→ keep a stable order instead. The root itself is
 * not a subagent.
 */
export function subagentOrder(sessions: ReadonlyArray<SessionNode>, sessionID: string): string[] {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const children = new Map<string, string[]>()
  const started = (session: SessionNode) => session.time?.created ?? 0
  for (const session of sessions.toSorted((a, b) => started(a) - started(b))) {
    if (!session.parentID) continue
    children.set(session.parentID, [...(children.get(session.parentID) ?? []), session.id])
  }
  let root = sessionID
  const seen = new Set<string>()
  for (let parent = byID.get(root)?.parentID; parent && !seen.has(parent); parent = byID.get(root)?.parentID) {
    seen.add(parent)
    root = parent
  }
  const walk = (id: string, path: ReadonlySet<string>): string[] =>
    (children.get(id) ?? []).flatMap((child) =>
      path.has(child) ? [] : [child, ...walk(child, new Set([...path, child]))],
    )
  return walk(root, new Set([root]))
}

/**
 * The subagent ←/→ moves to from `current`: the next (`step` 1) or previous
 * (`step` -1) of `order` that `reachable` accepts, wrapping around. The
 * current session stays in the cycle so a finished one keeps its place.
 * Undefined when no other subagent is reachable.
 */
export function neighbour(
  order: ReadonlyArray<string>,
  current: string,
  step: 1 | -1,
  reachable: (id: string) => boolean,
): string | undefined {
  const cycle = order.filter((id) => id === current || reachable(id))
  const at = cycle.indexOf(current)
  if (at < 0 || cycle.length < 2) return undefined
  return cycle[(at + step + cycle.length) % cycle.length]
}

/**
 * The line above the composer that says how to move: in a subagent, the way
 * back and, when another subagent runs, the way across; in a session with
 * subagents running, the way down to them. Empty otherwise.
 */
export function navigationHint(input: { readonly child: boolean; readonly others: number }): string {
  if (input.child) return input.others > 0 ? "↑ back to parent · ←/→ other subagents" : "↑ back to parent"
  return input.others > 0 ? "↓ subagents" : ""
}

/** The top bar's title: a subagent's own title behind its parent's (`three workers › Fix CSV quoting`), so it reads where it sits. */
export function topTitle(
  session: SessionNode | undefined,
  parent: SessionNode | undefined,
): { readonly parent?: string; readonly title: string } {
  const title = session?.title ?? ""
  return session?.parentID && parent?.title ? { parent: parent.title, title } : { title }
}

/**
 * Which sessions of a family work now: the host runs them (`running`), or
 * their subagent row runs or is blocked. A subagent that ended its turn to
 * wait on its own background work is idle to the host, yet still working.
 */
export function working(family: Family, running: (id: string) => boolean): (id: string) => boolean {
  const live = new Set(
    subagents(family, family.root).flatMap((row) => (row.state === "running" || row.state === "blocked" ? [row.id] : [])),
  )
  return (id) => running(id) || live.has(id)
}

/** How many of `order` other than `current` work now: in a subagent its running siblings, in a session its running subagents. */
export function othersWorking(order: ReadonlyArray<string>, current: string | undefined, works: (id: string) => boolean): number {
  return order.filter((id) => id !== current && works(id)).length
}
