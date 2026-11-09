// What the runner has not taken: which prompts wait, the queued rows that show
// them, and when the loader shows and what it times.
import { describe, expect, test } from "bun:test"
import {
  isWaiting,
  keyLabel,
  loader,
  pendingActions,
  queuedRow,
  sendHint,
  waitingPrompts,
  type Inbox,
  type PendingItem,
} from "./pending.ts"
import type { Message } from "./session.ts"

const steer = (id: string, created: number, text: string): PendingItem => ({
  id,
  type: "user",
  time: { created },
  delivery: "steer",
  payload: { text },
})
const user = (id: string, created: number): Message => ({ id, type: "user", time: { created }, text: id })
const step = (id: string, created: number): Message => ({ id, type: "assistant", time: { created }, content: [] })
const idle = (id: string, created: number): Message => ({ id, type: "idle", time: { created } })
const compaction = (id: string, created: number, status: "running" | "completed"): Message =>
  status === "running"
    ? { id, type: "compaction", time: { created }, reason: "auto", status, summary: "" }
    : { id, type: "compaction", time: { created }, reason: "auto", status, summary: "done" }

/** A turn the runner is busy on: a prompt it took and a model step, after an earlier turn's idle marker. */
const turn = [user("msg_0", 1), step("msg_01", 2), idle("msg_02", 3), user("msg_1", 4), step("msg_2", 5)]
const running = (pending: ReadonlyArray<PendingItem>, messages: ReadonlyArray<Message> = turn): Inbox => ({
  pending,
  messages,
  status: "running",
})

describe("the prompts the runner has not taken", () => {
  test("while a turn runs a pending user prompt waits; a taken one, a synthetic and a compaction do not", () => {
    const pending: PendingItem[] = [
      steer("msg_b", 2, "Also update the docs."),
      { id: "msg_s", type: "synthetic", time: { created: 3 }, delivery: "steer" },
      { id: "msg_c", type: "compaction", time: { created: 4 }, delivery: "steer" },
    ]
    const inbox = running(pending, [...turn, user("msg_b", 6)])
    expect(isWaiting(inbox, "msg_b")).toBe(true)
    expect(isWaiting(inbox, "msg_a")).toBe(false)
    expect(isWaiting(inbox, "msg_s")).toBe(false)
    expect(isWaiting(inbox, "msg_c")).toBe(false)
  })

  test("while a turn runs the queued rows list steers and queued prompts as one list, oldest first", () => {
    const pending: PendingItem[] = [
      steer("msg_c", 30, "third"),
      { ...steer("msg_q", 10, "later"), delivery: "queue" },
      steer("msg_a", 5, "first"),
      { id: "msg_s", type: "synthetic", time: { created: 1 }, delivery: "steer" },
    ]
    expect(waitingPrompts(running(pending))).toEqual([
      { id: "msg_a", text: "first", delivery: "steer" },
      { id: "msg_q", text: "later", delivery: "queue" },
      { id: "msg_c", text: "third", delivery: "steer" },
    ])
    expect(waitingPrompts(running([]))).toEqual([])
  })

  test("a prompt sent to an idle session is no queued prompt: no row, and the transcript shows it", () => {
    const sent = [steer("msg_9", 9, "Check the build.")]
    const messages = [...turn, idle("msg_3", 6), user("msg_9", 9)]
    const idleInbox: Inbox = { pending: sent, messages, status: "idle" }
    expect(waitingPrompts(idleInbox)).toEqual([])
    expect(isWaiting(idleInbox, "msg_9")).toBe(false)
    // A new session's first prompt: nothing before it at all.
    const first: Inbox = { pending: sent, messages: [user("msg_9", 9)], status: "idle" }
    expect(waitingPrompts(first)).toEqual([])
    expect(isWaiting(first, "msg_9")).toBe(false)
  })

  test("a run that has taken nothing yet starts with the prompt: the host says it runs, still no row", () => {
    const sent = [steer("msg_9", 9, "Check the build.")]
    for (const messages of [[user("msg_9", 9)], [...turn, idle("msg_3", 6), user("msg_9", 9)]]) {
      expect(waitingPrompts(running(sent, messages))).toEqual([])
      expect(isWaiting(running(sent, messages), "msg_9")).toBe(false)
    }
  })

  test("a run busy on a program's message or a compaction holds a prompt sent behind it", () => {
    const sent = [steer("msg_9", 9, "Check the build.")]
    const wake: Message = { id: "msg_w", type: "synthetic", time: { created: 7 }, text: "a shell ended" }
    for (const busy of [wake, compaction("msg_k", 7, "running")]) {
      const inbox = running(sent, [...turn, idle("msg_3", 6), busy, user("msg_9", 9)])
      expect(isWaiting(inbox, "msg_9")).toBe(true)
      expect(waitingPrompts(inbox).map((prompt) => prompt.id)).toEqual(["msg_9"])
    }
  })

  test("the rows and the transcript agree: a prompt is a row exactly while the transcript leaves it out", () => {
    const pending = [steer("msg_8", 8, "a"), { ...steer("msg_9", 9, "b"), delivery: "queue" as const }]
    const messages = [...turn, user("msg_8", 8), user("msg_9", 9)]
    for (const status of ["idle", "running"] as const) {
      const inbox: Inbox = { pending, messages, status }
      const rows = new Set(waitingPrompts(inbox).map((prompt) => prompt.id))
      for (const id of ["msg_8", "msg_9"]) expect(isWaiting(inbox, id)).toBe(rows.has(id))
    }
  })

  test("a row reads `◌ queued · <text>` for a steer, `◌ after the turn · <text>` for a queued prompt, cut to its width", () => {
    expect(queuedRow({ id: "m", text: "Also update\nthe docs.", delivery: "steer" }, 80)).toBe(
      "◌ queued · Also update the docs.",
    )
    expect(queuedRow({ id: "m", text: "Then bump the version.", delivery: "queue" }, 80)).toBe(
      "◌ after the turn · Then bump the version.",
    )
    const cut = queuedRow({ id: "m", text: "Also update the docs and the changelog too.", delivery: "steer" }, 24)
    expect([...cut].length).toBeLessThanOrEqual(24)
    expect(cut.startsWith("◌ queued · Also")).toBe(true)
  })

  test("a click offers a steer Move to queue or Delete, a queued prompt Send now or Delete", () => {
    expect(pendingActions("steer").map((action) => [action.title, action.value])).toEqual([
      ["Move to queue", "queue"],
      ["Delete", "cancel"],
    ])
    expect(pendingActions("queue").map((action) => [action.title, action.value])).toEqual([
      ["Send now", "steer"],
      ["Delete", "cancel"],
    ])
  })

  test("the send hint shows while a turn runs and a prompt waits, with the key the escape plugin binds", () => {
    expect(sendHint({ shortcut: "ctrl+return", running: true, waiting: 1 })).toBe("Ctrl+Enter interrupt and send")
    expect(sendHint({ shortcut: "ctrl+return", running: false, waiting: 1 })).toBe("")
    expect(sendHint({ shortcut: "ctrl+return", running: true, waiting: 0 })).toBe("")
    expect(sendHint({ shortcut: undefined, running: true, waiting: 1 })).toBe("")
    expect(keyLabel("ctrl+shift+s")).toBe("Ctrl+Shift+S")
  })
})

describe("the loader", () => {
  test("no loader while a compaction of the current run runs: its own row spins and counts", () => {
    const messages = [user("msg_1", 100), step("msg_2", 110), compaction("msg_3", 500, "running"), user("msg_4", 600)]
    expect(loader(messages, [steer("msg_4", 600, "next")])).toBeUndefined()
  })

  test("after the compaction the turn is `Executing` again, from its first step, not from the prompt that waited", () => {
    const messages = [user("msg_1", 100), step("msg_2", 110), compaction("msg_3", 500, "completed"), user("msg_4", 600), step("msg_5", 900)]
    expect(loader(messages, [])).toEqual({ since: 110 })
  })

  test("a prompt that waited behind a compaction of an idle session counts from the step that took it", () => {
    const messages = [user("msg_1", 100), step("msg_2", 110), idle("msg_3", 120), compaction("msg_4", 500, "completed"), user("msg_5", 600), step("msg_6", 2_000)]
    expect(loader(messages, [])).toEqual({ since: 2_000 })
  })

  test("a waiting steer never moves the clock; before the first step it counts from the prompt the runner took", () => {
    const run = [user("msg_1", 100), step("msg_2", 110), idle("msg_3", 120), user("msg_4", 1_000)]
    expect(loader(run, [])).toEqual({ since: 1_000 })
    expect(loader([...run, step("msg_5", 1_010), user("msg_6", 5_000)], [steer("msg_6", 5_000, "more")])).toEqual({
      since: 1_010,
    })
    // Only a waiting prompt in the run: the loader times from when it saw the run.
    expect(loader([...run.slice(0, 3), user("msg_7", 9_000)], [steer("msg_7", 9_000, "x")])).toEqual({ since: undefined })
  })

  test("a compaction an earlier run left running is not this run's", () => {
    const messages = [compaction("msg_1", 50, "running"), idle("msg_2", 60), user("msg_3", 100), step("msg_4", 105)]
    expect(loader(messages, [])).toEqual({ since: 105 })
  })
})
