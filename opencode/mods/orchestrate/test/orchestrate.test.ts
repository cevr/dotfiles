// The orchestrate plugin's rules on their own: the guard's routing, the
// compaction windows, the Sabbath hours, and its tool hook against a
// stand-in host. No OpenCode; tests/orchestrate.test.ts runs it in OpenCode.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { route } from "../src/roles.ts"
import { KNOWLTON, why } from "../src/sabbath.ts"
import { orchestrate } from "../src/server.ts"
import { DEFAULTS, parseWindows, windows } from "../src/windows.ts"

const scratch = mkdtempSync(join(tmpdir(), "orchestrate-unit-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

describe("the guard's routing", () => {
  test("an untyped or general call runs as the worker; a former role name as the role", () => {
    expect(route(undefined)).toEqual({ agent: "worker", reason: "untyped" })
    expect(route("")).toEqual({ agent: "worker", reason: "untyped" })
    for (const name of ["general", "general-purpose", "claude", "status:general"])
      expect(route(name)).toEqual({ agent: "worker", reason: "general" })
    expect(route("orchestrate-reviewer")).toEqual({ agent: "verifier", reason: "renamed" })
    for (const role of ["planner", "implementor", "verifier", "worker"])
      expect(route(`orchestrate-${role}`)).toEqual({ agent: role, reason: "renamed" })
    expect(route("explore")).toEqual({ agent: "explore", reason: "kept" })
    expect(route("planner")).toEqual({ agent: "planner", reason: "kept" })
  })

  test("with the full-agent escape, a general call runs as asked", () => {
    expect(route(undefined, true)).toEqual({ agent: "general", reason: "kept" })
    expect(route("general", true)).toEqual({ agent: "general", reason: "kept" })
    expect(route("orchestrate-reviewer", true)).toEqual({ agent: "verifier", reason: "renamed" })
  })
})

describe("the compaction windows", () => {
  test("compact.json's windows, capped at each role's; a former name counts unless the current one is set", () => {
    expect(
      parseWindows(JSON.stringify({ windows: { planner: 50_000, "orchestrate-reviewer": 120_000, worker: -1, root: 2e6 } })),
    ).toEqual({ planner: 50_000, verifier: 120_000 })
    expect(parseWindows(JSON.stringify({ windows: { verifier: 90_000, "orchestrate-reviewer": 120_000 } }))).toEqual({
      verifier: 90_000,
    })
    const file = join(scratch, "compact.json")
    writeFileSync(file, JSON.stringify({ windows: { planner: 900_000, worker: 150_000, root: 600_000 } }))
    expect(windows(file)).toEqual({ ...DEFAULTS, planner: 400_000, worker: 150_000, root: 600_000 })
  })

  test("no file, or a broken one, gives the defaults", () => {
    expect(windows(join(scratch, "missing.json"))).toEqual(DEFAULTS)
    const broken = join(scratch, "broken.json")
    writeFileSync(broken, "{")
    expect(windows(broken)).toEqual(DEFAULTS)
    expect(DEFAULTS).toEqual({ planner: 400_000, implementor: 400_000, verifier: 400_000, worker: 200_000, root: 400_000 })
  })
})

describe("the Sabbath", () => {
  test("Friday evening is in it, and the message says when work resumes; Wednesday is not", () => {
    expect(why(Date.parse(FRIDAY_EVENING), KNOWLTON)).toMatch(SABBATH)
    expect(why(Date.parse(WEDNESDAY), KNOWLTON)).toBeUndefined()
    // Friday afternoon, before sunset, is not yet; Saturday evening's half hour after sunset still is.
    expect(why(Date.parse("2026-10-30T20:00:00Z"), KNOWLTON)).toBeUndefined()
    expect(why(Date.parse("2026-10-31T22:00:00Z"), KNOWLTON)).toMatch(SABBATH)
  })

  /** The plugin on a stand-in host: its tool hooks, and a session store the test sets. */
  const host = async (now: number, sessions: Record<string, { parentID?: string }>) => {
    const before: Array<(event: Record<string, unknown>) => Promise<void> | void> = []
    const ctx = {
      options: { log: join(scratch, "unit.jsonl"), windows: join(scratch, "missing.json") },
      agent: { transform: async () => ({}), reload: async () => {}, get: async () => ({}) },
      model: { list: async () => ({ data: [] }), default: async () => ({ data: null }) },
      session: {
        hook: async () => ({}),
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: scratch }, ...sessions[sessionID] }),
      },
      tool: {
        hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
          if (name === "execute.before") before.push(callback)
          return {}
        },
      },
    }
    const cleanup = await orchestrate({ now: () => now }).setup(ctx as never)
    const call = async (tool: string, sessionID: string, input: unknown = {}) => {
      try {
        for (const callback of before) await callback({ tool, sessionID, agent: "build", messageID: "msg", id: "call", input })
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    }
    return { call, cleanup: cleanup as (() => Promise<void>) | undefined }
  }

  test("in it, a running subagent's tools are refused; the main session's own tools are not", async () => {
    const friday = await host(Date.parse(FRIDAY_EVENING), { root: {}, child: { parentID: "root" } })
    try {
      expect(await friday.call("subagent", "root", { prompt: "x" })).toEndWith(
        "No agent starts now. Do not retry; start it again once work resumes.",
      )
      expect(await friday.call("shell", "child")).toEndWith(
        "Stop now: end your turn with one line on where you stopped. Make no more tool calls.",
      )
      expect(await friday.call("shell", "root")).toBeUndefined()
    } finally {
      await friday.cleanup?.()
    }
    const wednesday = await host(Date.parse(WEDNESDAY), { root: {}, child: { parentID: "root" } })
    try {
      expect(await wednesday.call("shell", "child")).toBeUndefined()
    } finally {
      await wednesday.cleanup?.()
    }
  })
})
