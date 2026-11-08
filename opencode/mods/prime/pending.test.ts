// What the runner has not taken: which prompts wait, the queued rows that show
// them, and what the loader names and times while a compaction or a turn runs.
import { describe, expect, test } from "bun:test"
import { isWaiting, loader, loaderMargin, queuedRow, waitingPrompts, type PendingItem } from "./pending.ts"
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

  test("the queued rows list the steers oldest first; a queue-delivery prompt stays the host's queued dock's", () => {
    const pending: PendingItem[] = [
      steer("msg_c", 30, "third"),
      { ...steer("msg_q", 10, "later"), delivery: "queue" },
      steer("msg_a", 5, "first"),
    ]
    expect(waitingPrompts(pending)).toEqual([
      { id: "msg_a", text: "first" },
      { id: "msg_c", text: "third" },
    ])
    expect(waitingPrompts([])).toEqual([])
  })

  test("a row reads `◌ queued · <text>` on one line, cut to its width", () => {
    expect(queuedRow({ id: "m", text: "Also update\nthe docs." }, 80)).toBe("◌ queued · Also update the docs.")
    const cut = queuedRow({ id: "m", text: "Also update the docs and the changelog too." }, 24)
    expect([...cut].length).toBeLessThanOrEqual(24)
    expect(cut.startsWith("◌ queued · Also")).toBe(true)
  })
})

describe("the loader", () => {
  test("its blank row is the hidden prompt's gap while a steer waits, its own otherwise", () => {
    expect(loaderMargin([steer("msg_b", 2, "x")], 1)).toBe(0)
    expect(loaderMargin([], 1)).toBe(1)
    // Overview gives a prompt no gap, and a queue-delivery prompt has no row at all.
    expect(loaderMargin([steer("msg_b", 2, "x")], 0)).toBe(1)
    expect(loaderMargin([{ ...steer("msg_q", 2, "x"), delivery: "queue" }], 1)).toBe(1)
  })

  test("a compaction running in the current run is `Compacting`, from the compaction's start", () => {
    const messages = [user("msg_1", 100), step("msg_2", 110), compaction("msg_3", 500, "running"), user("msg_4", 600)]
    expect(loader(messages, [steer("msg_4", 600, "next")])).toEqual({ label: "Compacting", since: 500 })
  })

  test("after the compaction the turn is `Executing` again, from its first step, not from the prompt that waited", () => {
    const messages = [user("msg_1", 100), step("msg_2", 110), compaction("msg_3", 500, "completed"), user("msg_4", 600), step("msg_5", 900)]
    expect(loader(messages, [])).toEqual({ label: "Executing", since: 110 })
  })

  test("a prompt that waited behind a compaction of an idle session counts from the step that took it", () => {
    const messages = [user("msg_1", 100), step("msg_2", 110), idle("msg_3", 120), compaction("msg_4", 500, "completed"), user("msg_5", 600), step("msg_6", 2_000)]
    expect(loader(messages, [])).toEqual({ label: "Executing", since: 2_000 })
  })

  test("a waiting steer never moves the clock; before the first step it counts from the prompt the runner took", () => {
    const run = [user("msg_1", 100), step("msg_2", 110), idle("msg_3", 120), user("msg_4", 1_000)]
    expect(loader(run, [])).toEqual({ label: "Executing", since: 1_000 })
    expect(loader([...run, step("msg_5", 1_010), user("msg_6", 5_000)], [steer("msg_6", 5_000, "more")])).toEqual({
      label: "Executing",
      since: 1_010,
    })
    // Only a waiting prompt in the run: the loader times from when it saw the run.
    expect(loader([...run.slice(0, 3), user("msg_7", 9_000)], [steer("msg_7", 9_000, "x")]).since).toBeUndefined()
  })

  test("a compaction an earlier run left running is not this run's", () => {
    const messages = [compaction("msg_1", 50, "running"), idle("msg_2", 60), user("msg_3", 100), step("msg_4", 105)]
    expect(loader(messages, [])).toEqual({ label: "Executing", since: 105 })
  })
})
