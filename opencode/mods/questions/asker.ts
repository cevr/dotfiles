// Who asked: how a subagent that asked is named where its questions show, in
// the form of the session on screen and in the notice its root session gets
// when one is answered. A subagent's title is the description it was started
// with ("implementor auth r1"); its agent goes beside it in parentheses when
// the title does not already name it.
import type { SessionInfo } from "./service.ts"

/** The words of `text`, as the user means them: case does not count. */
const words = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word !== "")

/** The name of the session that asked: its title (with its agent unless the title names it), else its agent, else its id. */
export const askerOf = (session: Pick<SessionInfo, "id" | "title" | "agent">): string => {
  const title = session.title?.replace(/\s+/g, " ").trim() ?? ""
  const agent = session.agent?.trim() ?? ""
  if (title === "") return agent === "" ? session.id : agent
  if (agent === "" || words(title).includes(agent.toLowerCase())) return title
  return `${title} (${agent})`
}
