import { describe, expect, test } from "bun:test"
import { decide, DEFAULT_GRACE_MS, SETTLE_MS, type View } from "./escape.ts"

const SENT = 100_000

/** A root session, busy, its newest prompt sent at SENT, the composer empty; `change` overrides. */
const view = (change: Partial<View> = {}): View => ({
  sessionID: "ses_root",
  subagent: false,
  busy: true,
  blocked: false,
  latest: { id: "msg_1", created: SENT, pending: false, ranShell: false },
  composer: "empty",
  ...change,
})
const at = (ms: number) => ({ now: SENT + ms, grace: DEFAULT_GRACE_MS })

describe("decide", () => {
  test("within the grace, Escape takes the prompt back", () => {
    expect(decide(view(), at(1_000))).toEqual({ _tag: "TakeBack", messageID: "msg_1", pending: false, ranShell: false })
    expect(decide(view(), at(4_999))._tag).toBe("TakeBack")
  })

  test("from the grace on, Escape interrupts and the prompt stays", () => {
    expect(decide(view(), at(5_000))).toEqual({ _tag: "Interrupt", sessionID: "ses_root" })
    expect(decide(view(), at(7_000))).toEqual({ _tag: "Interrupt", sessionID: "ses_root" })
  })

  test("a grace of 0 always interrupts", () => {
    expect(decide(view(), { now: SENT, grace: 0 })._tag).toBe("Interrupt")
  })

  test("a pending prompt comes back whatever the grace, idle or busy", () => {
    const latest = { id: "msg_2", created: SENT, pending: true, ranShell: false }
    expect(decide(view({ latest }), at(60_000))).toEqual({ _tag: "TakeBack", messageID: "msg_2", pending: true, ranShell: false })
    expect(decide(view({ latest, busy: false }), at(60_000))._tag).toBe("TakeBack")
  })

  test("a take-back says when the run called a shell, which the revert does not undo", () => {
    const latest = { id: "msg_1", created: SENT, pending: false, ranShell: true }
    expect(decide(view({ latest }), at(1_000))).toMatchObject({ _tag: "TakeBack", ranShell: true })
  })

  test("a draft in the composer leaves the session alone and keeps the key from the host", () => {
    expect(decide(view({ composer: "draft" }), at(1_000))).toEqual({ _tag: "Hold" })
    expect(decide(view({ composer: "draft" }), at(7_000))).toEqual({ _tag: "Hold" })
  })

  test("with no editor focused, or an idle session with nothing pending, the key is the host's", () => {
    expect(decide(view({ composer: "none" }), at(1_000))).toEqual({ _tag: "Pass" })
    expect(decide(view({ busy: false }), at(1_000))).toEqual({ _tag: "Pass" })
    expect(decide(view({ busy: false, composer: "draft" }), at(1_000))).toEqual({ _tag: "Pass" })
    expect(decide(undefined, at(1_000))).toEqual({ _tag: "Pass" })
  })

  test("a permission request or a question waiting for the user keeps Escape theirs", () => {
    expect(decide(view({ blocked: true }), at(1_000))).toEqual({ _tag: "Pass" })
  })

  test("a busy session with no prompt of its own interrupts", () => {
    expect(decide(view({ latest: undefined }), at(1_000))).toEqual({ _tag: "Interrupt", sessionID: "ses_root" })
  })

  test("a second Escape while the take-back settles is swallowed, so it cannot take back twice", () => {
    const taking = { messageID: "msg_1", at: SENT + 1_000 }
    expect(decide(view(), { ...at(1_500), taking })).toEqual({ _tag: "Hold" })
    // Another prompt, or a take-back long past settling, is decided afresh.
    expect(decide(view({ latest: { id: "msg_2", created: SENT, pending: false, ranShell: false } }), { ...at(1_500), taking })._tag).toBe("TakeBack")
    expect(decide(view({ latest: { id: "msg_1", created: SENT + SETTLE_MS, pending: false, ranShell: false } }), { now: SENT + SETTLE_MS + 1_000, grace: DEFAULT_GRACE_MS, taking })._tag).toBe("TakeBack")
  })

  test("in a subagent's view Escape interrupts that subagent while it runs, else closes the picker as before", () => {
    expect(decide(view({ subagent: true, sessionID: "ses_child" }), at(1_000))).toEqual({ _tag: "Interrupt", sessionID: "ses_child" })
    expect(decide(view({ subagent: true, busy: false }), at(1_000))).toEqual({ _tag: "Pass" })
  })
})
