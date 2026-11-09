import { describe, expect, test } from "bun:test"
import type { View } from "./escape.ts"
import { decideSend, plan, type Waiting } from "./send.ts"

/** A root session, busy, the composer empty; `change` overrides. */
const view = (change: Partial<View> = {}): View => ({
  sessionID: "ses_root",
  subagent: false,
  busy: true,
  blocked: false,
  latest: { id: "msg_1", created: 0, pending: false, ranShell: false },
  composer: "empty",
  ...change,
})
const steer: Waiting = { id: "msg_2", delivery: "steer" }
const queued: Waiting = { id: "msg_3", delivery: "queue" }

describe("decideSend", () => {
  test("a busy session with a draft interrupts and sends it, whatever waits", () => {
    expect(decideSend(view({ composer: "draft" }), [])).toEqual({ _tag: "InterruptSend", sessionID: "ses_root", draft: true })
    expect(decideSend(view({ composer: "draft" }), [queued])).toEqual({ _tag: "InterruptSend", sessionID: "ses_root", draft: true })
  })

  test("a busy session with an empty composer interrupts and sends what waits, steers or queued prompts", () => {
    expect(decideSend(view(), [steer])).toEqual({ _tag: "InterruptSend", sessionID: "ses_root", draft: false })
    expect(decideSend(view(), [queued])).toEqual({ _tag: "InterruptSend", sessionID: "ses_root", draft: false })
  })

  test("a busy session with nothing to send does nothing: it never interrupts alone", () => {
    expect(decideSend(view(), [])).toEqual({ _tag: "Nothing" })
  })

  test("an idle session submits, as Enter does, draft or not", () => {
    expect(decideSend(view({ busy: false }), [])).toEqual({ _tag: "Submit" })
    expect(decideSend(view({ busy: false, composer: "draft" }), [queued])).toEqual({ _tag: "Submit" })
  })

  test("off a session, under a question or permission, in a subagent's view or with no editor focused, the key is the host's", () => {
    expect(decideSend(undefined, [queued])).toEqual({ _tag: "Pass" })
    expect(decideSend(view({ blocked: true, composer: "draft" }), [queued])).toEqual({ _tag: "Pass" })
    expect(decideSend(view({ subagent: true }), [queued])).toEqual({ _tag: "Pass" })
    expect(decideSend(view({ composer: "none" }), [queued])).toEqual({ _tag: "Pass" })
  })
})

describe("plan", () => {
  test("only steers waiting: the interrupt resumes them, nothing moves", () => {
    expect(plan([steer])).toEqual({ resume: true, promote: [] })
    expect(plan([])).toEqual({ resume: true, promote: [] })
  })

  test("queued prompts: no resume, and each moves to the steers in the order given, the steers left as they are", () => {
    expect(plan([steer, queued, { id: "msg_4", delivery: "queue" }])).toEqual({ resume: false, promote: ["msg_3", "msg_4"] })
  })
})
