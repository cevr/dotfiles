import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { formatUnsupportedRevision } from "./service.ts"
import { isLive, parseDescription, rowOf, type PaneWorkerView } from "./worker.ts"

const sampleView = (overrides: Partial<PaneWorkerView> = {}): PaneWorkerView => ({
  id: "pa_abc123",
  parentSessionID: "ses_parent",
  harness: "agy",
  role: "implementor",
  unit: "pane-agent r1",
  blockId: "block:01a",
  rexSessionId: "session:01s",
  resultFile: "/tmp/run/pane-agent-request.md",
  state: "working",
  update: "running in Rex pane",
  startedAt: 1000,
  updatedAt: 2000,
  ...overrides,
})

describe("pane worker row projection", () => {
  test("shows the harness name where the model name goes", () => {
    const row = rowOf(sampleView())
    expect(row.model.name).toBe("agy")
    expect(row.role).toBe("implementor")
    expect(row.tone).toBe("implementor")
    expect(row.unit).toBe("pane-agent r1")
    expect(row.state).toBe("working")
    expect(row.since).toBe(1000)
    expect(row.heard).toBe(2000)
  })

  test("maps needs_input and pane_gone to blocked and stopped to cancelled", () => {
    const blocked = rowOf(sampleView({ state: "needs_input", update: "Workspace trust confirmation required" }))
    expect(blocked.state).toBe("blocked")
    expect(isLive("needs_input")).toBe(true)

    const gone = rowOf(sampleView({ state: "pane_gone", update: "pane gone (use restart to resume with --continue)", endedAt: 3500 }))
    expect(gone.state).toBe("blocked")
    expect(gone.ended).toBe(3500)
    expect(isLive("pane_gone")).toBe(false)

    const unreachable = rowOf(sampleView({ state: "rex_unreachable", update: "Rex unreachable after 5 attempts" }))
    expect(unreachable.state).toBe("blocked")
    expect(isLive("rex_unreachable")).toBe(true)

    const undelivered = rowOf(sampleView({ state: "wake_undelivered", update: "wake undelivered after 5 attempts" }))
    expect(undelivered.state).toBe("blocked")
    expect(isLive("wake_undelivered")).toBe(false)

    const stopped = rowOf(sampleView({ state: "stopped", update: "stopped", endedAt: 4000 }))
    expect(stopped.state).toBe("cancelled")
    expect(stopped.ended).toBe(4000)

    expect(parseDescription("verifier pane-agent r2")).toEqual({ role: "verifier", unit: "pane-agent r2" })
    expect(parseDescription("quick check")).toEqual({ role: "worker", unit: "quick check" })
  })

  test("formats RexUnsupportedApiRevision naming both revisions in a plain sentence", () => {
    const both = formatUnsupportedRevision(18, Option.some(19))
    expect(both).toContain("18")
    expect(both).toContain("19")
    const unknown = formatUnsupportedRevision(18, Option.none())
    expect(unknown).toContain("18")
  })
})
