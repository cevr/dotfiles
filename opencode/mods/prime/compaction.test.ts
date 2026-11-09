// A compaction's words: one line below All, the host's block at All.
import { describe, expect, test } from "bun:test"
import { compactionAt, compactionBlock, compactionLine, compactionTime } from "./compaction.ts"
import type { CompactionMessage, Message, Tokens } from "./session.ts"

// The compaction request read 171k tokens of context and wrote a 6k summary.
const tokens: Tokens = { input: 20_000, output: 6_000, reasoning: 0, cache: { read: 150_000, write: 1_000 } }
const at = { created: 1_000 }
const done = (reason: "auto" | "manual", extra: Partial<{ tokens: Tokens }> = { tokens }): CompactionMessage => ({
  id: "c1",
  type: "compaction",
  status: "completed",
  reason,
  summary: "## Goal\nShip the parser.",
  time: at,
  ...extra,
})
const failed = (type: string, message: string): CompactionMessage => ({
  id: "c1",
  type: "compaction",
  status: "failed",
  reason: "auto",
  error: { type, message },
  time: at,
})
const running = (reason: "auto" | "manual"): CompactionMessage => ({
  id: "c1",
  type: "compaction",
  status: "running",
  reason,
  summary: "",
  time: at,
})
// A settled compaction reads the same at any time.
const NOW = 1_000_000
// The step the compaction resumes, 12 seconds after it started.
const resumed: Message = { id: "a2", type: "assistant", time: { created: 13_000 }, content: [] }
const idle: Message = { id: "i1", type: "idle", time: { created: 4_000 } }

describe("a compaction's line below All", () => {
  test("an automatic one says so, with the context it compacted, the summary it left and its time", () => {
    expect(compactionLine(done("auto"), resumed, NOW)).toEqual({
      glyph: "◇",
      tone: "muted",
      text: "Compacted automatically · 171k → 6k tokens · 12.0s",
    })
  })

  test("a manual one is just Compacted; a run's idle marker ends it too", () => {
    expect(compactionLine(done("manual"), idle, NOW).text).toBe("Compacted · 171k → 6k tokens · 3.0s")
  })

  test("without usage or a run's next message it drops those parts", () => {
    expect(compactionLine(done("auto", {}), undefined, NOW).text).toBe("Compacted automatically")
    // A prompt the reader sent later says nothing of when the compaction ended.
    const later: Message = { id: "u2", type: "user", text: "next", time: { created: 900_000 } }
    expect(compactionLine(done("auto"), later, NOW).text).toBe("Compacted automatically · 171k → 6k tokens")
  })

  test("a failure and a cancel say so in the warning tone, the failure with its reason's first line", () => {
    expect(compactionLine(failed("provider", "Context too long\nat request 3"), idle, NOW)).toEqual({
      glyph: "◇",
      tone: "warning",
      text: "Compaction failed · Context too long",
    })
    expect(compactionLine(failed("aborted", "Compaction interrupted"), idle, NOW)).toEqual({
      glyph: "◇",
      tone: "warning",
      text: "Compaction cancelled",
    })
  })

  test("a running one is the live spinner line, with the host's words and the time it has run: the wait's only row", () => {
    expect(compactionLine(running("auto"), undefined, at.created + 57_400)).toEqual({
      glyph: "spinner",
      tone: "muted",
      text: "Automatic compaction · 57s",
    })
    expect(compactionLine(running("manual"), resumed, at.created + 4_000).text).toBe("Compaction · 4s")
    expect(compactionLine(running("auto"), undefined, at.created + 65_000).text).toBe("Automatic compaction · 1m 05s")
    expect(compactionTime(running("auto"), resumed)).toBeUndefined()
  })
})

describe("a compaction's block at All", () => {
  test("is the host's: its label and the request's usage over the summary", () => {
    expect(compactionBlock(done("auto"), NOW)).toEqual({
      running: false,
      failed: false,
      label: "Automatic compaction",
      details: ["171.0K in · 6.0K out"],
      body: "## Goal\nShip the parser.",
    })
    expect(compactionBlock(done("manual"), NOW).label).toBe("Compaction")
  })

  test("a failure shows its error under a ✗ rule; a cancel says cancelled and shows nothing under it", () => {
    expect(compactionBlock(failed("provider", "Context too long"), NOW)).toMatchObject({ failed: true, body: "Context too long" })
    expect(compactionBlock(failed("aborted", "Compaction interrupted"), NOW)).toMatchObject({
      failed: false,
      details: ["cancelled"],
      body: "",
    })
  })

  test("a running one carries the time it has run beside its spinner, as the line does", () => {
    expect(compactionBlock(running("auto"), at.created + 4_000)).toMatchObject({
      running: true,
      label: "Automatic compaction",
      details: ["4s"],
    })
  })
})

describe("the compaction a slot names", () => {
  test("is found with the message after it; any other message is none", () => {
    const messages: Message[] = [done("auto"), resumed]
    expect(compactionAt(messages, "c1")?.next).toBe(resumed)
    expect(compactionAt(messages, "a2")).toBeUndefined()
    expect(compactionAt(messages, "missing")).toBeUndefined()
  })
})
