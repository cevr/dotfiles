// Which sessions work now, from the host's live state, never a missing notice.
import { describe, expect, test } from "bun:test"
import type { Message, Session } from "./family.ts"
import { worksNow } from "./works.ts"

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  time: { created: 0 },
  running: false,
  shells: [],
  permissions: [],
  questions: [],
  messages: [],
  ...over,
})
const family = (...sessions: Session[]) => ({ root: "root", sessions })
const shell = (id: string) => ({ id, command: "sleep 999" })
// A background shell call with no stop notice: the transcript alone would say it still runs.
const unanswered: Message = {
  type: "assistant",
  parts: [{ type: "call", tool: "shell", status: "completed", input: { command: "sleep 999", background: true }, metadata: { shellID: "sh_1" } }],
}

describe("worksNow", () => {
  test("running, blocked and latched as the host says", () => {
    const works = worksNow(
      family(
        session("root"),
        session("run", { parentID: "root", running: true }),
        session("ask", { parentID: "root", running: true, questions: ["Which?"] }),
        session("held", { parentID: "root", latch: { hold: "pace", reason: "held", opensAt: 9, at: 1 } }),
        session("gone", { parentID: "root", latch: { hold: "pace", reason: "held", opensAt: 9, at: 1, cancelledAt: 2 } }),
      ),
    )
    expect(["run", "ask", "held", "gone", "nobody"].map(works)).toEqual(["running", "blocked", "latched", undefined, undefined])
  })

  test("an idle session waits while the registry lists a shell of its own as running", () => {
    expect(worksNow(family(session("a", { messages: [unanswered], shells: [shell("sh_1")] })))("a")).toBe("waiting")
  })

  test("with the shell gone from the registry and no notice, it does not work", () => {
    expect(worksNow(family(session("a", { messages: [unanswered] })))("a")).toBeUndefined()
  })

  test("a subagent under it that works keeps it waiting, at any depth", () => {
    const works = worksNow(
      family(
        session("a"),
        session("b", { parentID: "a" }),
        session("c", { parentID: "b", shells: [shell("sh_2")] }),
        session("d"),
        session("e", { parentID: "d", outcome: "succeeded" }),
      ),
    )
    expect(["a", "b", "c", "d", "e"].map(works)).toEqual(["waiting", "waiting", "waiting", undefined, undefined])
  })

  test("a cycle in the parents never loops", () => {
    const works = worksNow(family(session("a", { parentID: "b" }), session("b", { parentID: "a" })))
    expect([works("a"), works("b")]).toEqual([undefined, undefined])
    const live = worksNow(family(session("a", { parentID: "b" }), session("b", { parentID: "a", running: true })))
    expect([live("a"), live("b")]).toEqual(["waiting", "running"])
  })
})
