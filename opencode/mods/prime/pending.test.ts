// What the runner has not taken: which prompts wait, the queued rows that show
// them, and when the loader shows and what it times.
import { describe, expect, test } from "bun:test"
import { isWaiting, loader, pendingActions, queuedRow, waitingPrompts, type PendingItem } from "./pending.ts"
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

describe("the prompts the runner has not taken", () => {
  test("a pending user prompt waits; a taken one, a synthetic and a compaction do not", () => {
    const pending: PendingItem[] = [
      steer("msg_b", 2, "Also update the docs."),
      { id: "msg_s", type: "synthetic", time: { created: 3 }, delivery: "steer" },
      { id: "msg_c", type: "compaction", time: { created: 4 }, delivery: "steer" },
    ]
    expect(isWaiting(pending, "msg_b")).toBe(true)
    expect(isWaiting(pending, "msg_a")).toBe(false)
    expect(isWaiting(pending, "msg_s")).toBe(false)
    expect(isWaiting(pending, "msg_c")).toBe(false)
  })

  test("the queued rows list steers and queued prompts as one list, oldest first", () => {
    const pending: PendingItem[] = [
      steer("msg_c", 30, "third"),
      { ...steer("msg_q", 10, "later"), delivery: "queue" },
      steer("msg_a", 5, "first"),
      { id: "msg_s", type: "synthetic", time: { created: 1 }, delivery: "steer" },
    ]
    expect(waitingPrompts(pending)).toEqual([
      { id: "msg_a", text: "first", delivery: "steer" },
      { id: "msg_q", text: "later", delivery: "queue" },
      { id: "msg_c", text: "third", delivery: "steer" },
    ])
    expect(waitingPrompts([])).toEqual([])
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
