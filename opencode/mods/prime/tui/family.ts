// Who in a session's family works now, as the dock's count, the hint line and
// ←/→ read it. `working` is a plain read, for a keymap outside a component;
// `useWorking` and `useOthers` keep their values in memos that hold while
// who works stays the same, so a streamed token, a cost update or another
// session's change runs nothing that draws them.
import type { Family } from "@dotfiles/opencode-subagents/family"
import { keptMemo } from "@dotfiles/opencode-subagents/solid/kept"
import { Option } from "effect"
import { createMemo, type Accessor } from "solid-js"
import { othersWorking, working as familyWorking } from "../subagent.ts"
import type { Host } from "./host.ts"

const NONE: ReadonlyArray<string> = []

/** Whether two lists name the same sessions in the same order. */
export const sameIDs = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((id, index) => id === b[index])

/** Which subagents of `sessionID`'s family work now, as the host's live state says (subagent.ts). */
export function working(host: Host, sessionID: string): (id: string) => boolean {
  return familyWorking(host.subagents(sessionID))
}

/** The subagents of `family` that work now, in the family's order (subagent.ts `working`). */
export function workingIDs(family: Family): ReadonlyArray<string> {
  const works = familyWorking(family)
  return family.sessions.filter((session) => works(session.id)).map((session) => session.id)
}

/** The subagents of the session's family that work now; the same list while the same ones work (`sameIDs`). */
export function useWorking(host: Pick<Host, "subagents">, sessionID: Accessor<Option.Option<string>>): Accessor<ReadonlyArray<string>> {
  return keptMemo(
    () =>
      Option.match(sessionID(), {
        onNone: () => NONE,
        onSome: (id) => workingIDs(host.subagents(id)),
      }),
    sameIDs,
  )
}

/**
 * In a subagent, how many other subagents of its family work; in a session,
 * how many of its subagents do (subagent.ts `othersWorking`), from
 * `useWorking`: it runs again only when who works changes.
 */
export function useOthers(host: Pick<Host, "subagents">, sessionID: Accessor<Option.Option<string>>): Accessor<number> {
  const busy = useWorking(host, sessionID)
  return createMemo(() => othersWorking(busy(), Option.getOrElse(sessionID(), () => ""), () => true))
}
