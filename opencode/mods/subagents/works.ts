// Which sessions of a family work now, from the host's live state alone: the
// one answer the subagent rows, the dock's count, the ↓ hint and ←/→ all read,
// as the host's own Subagents panel does.
//
// - blocked: it waits on a permission or a question;
// - running: the host runs its turn;
// - latched: a held start, made and not yet started (the wakes' mark);
// - waiting: the host has it idle, yet a shell it started still runs (the
//   host's shell registry lists it) or a subagent under it works now.
//
// The transcript never keeps a session live: a background call with no stop
// notice is not work once the registry no longer lists its shell or its child
// stopped. A notice that never comes (a shell killed by PID or by the agent through its handle,
// a server restart) leaves nothing behind.
import type { Family, Session } from "./family.ts"

export type Works = "running" | "waiting" | "blocked" | "latched"

/** A held start still waiting to open: latched, never run, neither cancelled nor failed. */
export const latched = (session: Session) =>
  session.latch !== undefined &&
  session.latch.cancelledAt === undefined &&
  session.latch.failed === undefined &&
  session.time.busy === undefined &&
  session.outcome === undefined

/** `sessions` by parent id, each list in the order given; linear, for families of hundreds. */
export function childrenOf(sessions: ReadonlyArray<Session>): Map<string, Session[]> {
  const children = new Map<string, Session[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const siblings = children.get(session.parentID)
    if (siblings) siblings.push(session)
    else children.set(session.parentID, [session])
  }
  return children
}

const kept = new WeakMap<Family, (id: string) => Works | undefined>()

/**
 * How each session of `family` works now, by id; undefined for one that does
 * not (or that the family does not hold). Read once per family: the answer
 * for every session is worked out on the first call, and every reader of the
 * same family (the rows, the dock's count, the hints) shares it.
 */
export function worksNow(family: Family): (id: string) => Works | undefined {
  let works = kept.get(family)
  if (works === undefined) {
    works = worksOf(family)
    kept.set(family, works)
  }
  return works
}

function worksOf(family: Family): (id: string) => Works | undefined {
  const byID = new Map(family.sessions.map((session) => [session.id, session]))
  const children = childrenOf(family.sessions)
  const known = new Map<string, Works | undefined>()
  // `path` holds the sessions being worked out: a cycle in the parents counts nothing twice.
  const of = (id: string, path: ReadonlySet<string>): Works | undefined => {
    if (known.has(id)) return known.get(id)
    const session = byID.get(id)
    if (session === undefined || path.has(id)) return undefined
    const inner = new Set([...path, id])
    const works: Works | undefined =
      session.permissions.length > 0 || session.questions.length > 0
        ? "blocked"
        : session.running
          ? "running"
          : latched(session)
            ? "latched"
            : session.shells.length > 0 || (children.get(id) ?? []).some((child) => of(child.id, inner) !== undefined)
              ? "waiting"
              : undefined
    known.set(id, works)
    return works
  }
  return (id) => of(id, new Set())
}
