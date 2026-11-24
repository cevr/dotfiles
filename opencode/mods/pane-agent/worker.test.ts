import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { formatUnsupportedRevision } from "./service.ts"
import { rowOf, type PaneWorkerView } from "./worker.ts"

describe("pane worker row projection", () => {
  const sample = (overrides: Partial<PaneWorkerView> = {}): PaneWorkerView => ({
    id: "pa_abc123",
    parentSessionID: "ses_root",
    harness: "agy",
    role: "implementor",
    unit: "pane-agent r1",
    blockId: "block:01test",
    rexSessionId: "session:01test",
    resultFile: "/tmp/run/result.md",
    state: "working",
    update: "running in Rex pane",
    startedAt: 1000,
    updatedAt: 2000,
    ...overrides,
  })

  test("shows the harness name where the model name goes", () => {
    const row = rowOf(sample())
    expect(row.id).toBe("pa_abc123")
    expect(row.role).toBe("implementor")
    expect(row.model).toEqual({ name: "agy" })
    expect(row.unit).toBe("pane-agent r1")
    expect(row.state).toBe("working")
  })

  test("maps needs_input to blocked and stopped to cancelled", () => {
    expect(rowOf(sample({ state: "needs_input", update: "Allow command?" })).state).toBe("blocked")
    expect(rowOf(sample({ state: "stopped", endedAt: 3000 })).state).toBe("cancelled")
    expect(rowOf(sample({ state: "done", endedAt: 3000 })).state).toBe("done")
    expect(rowOf(sample({ state: "failed", endedAt: 3000 })).state).toBe("failed")
  })

  test("formats RexUnsupportedApiRevision naming both revisions in a plain sentence", () => {
    const text = formatUnsupportedRevision(18, Option.some(19))
    expect(text).toContain("18")
    expect(text).toContain("19")
    const unknownServer = formatUnsupportedRevision(18, Option.none())
    expect(unknownServer).toContain("18")
  })
})
