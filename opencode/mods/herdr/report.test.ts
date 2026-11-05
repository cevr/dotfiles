import { describe, expect, test } from "bun:test"
import { agentParams, changes, METADATA_TTL_MS, metadataParams, nextSeq, paneOf, releaseParams, resumeArgv, SOURCE, validResumeArgv } from "./report.ts"

describe("paneOf", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w8:p3", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }
  test("inside a herdr pane: the pane and its socket", () => expect(paneOf(env)).toEqual({ paneId: "w8:p3", socketPath: "/tmp/herdr.sock" }))
  test("off unless HERDR_ENV is 1 and both the pane and the socket are named", () => {
    expect(paneOf({})).toBeUndefined()
    expect(paneOf({ ...env, HERDR_ENV: "0" })).toBeUndefined()
    expect(paneOf({ ...env, HERDR_PANE_ID: "" })).toBeUndefined()
    expect(paneOf({ ...env, HERDR_SOCKET_PATH: undefined })).toBeUndefined()
  })
})

describe("nextSeq", () => {
  test("tracks the clock in microseconds", () => expect(nextSeq(0, 1_700_000_000_000)).toBe(1_700_000_000_000_000))
  test("always rises, even when the clock stands still or steps back", () => {
    const first = nextSeq(0, 1000)
    expect(nextSeq(first, 1000)).toBe(first + 1)
    expect(nextSeq(first + 1, 999)).toBe(first + 2)
  })
})

describe("the source", () => {
  test("is ours, in herdr's source charset, never herdr's namespace", () => {
    expect(SOURCE).toMatch(/^[A-Za-z0-9:._-]{1,80}$/)
    expect(SOURCE.startsWith("herdr:")).toBe(false)
  })
})

describe("resume argv", () => {
  test("reopens the session with opencode -s", () => expect(resumeArgv("ses_abc123")).toEqual(["opencode", "-s", "ses_abc123"]))
  test("an id herdr would refuse gives no command", () => {
    expect(resumeArgv("ses_it's")).toBeUndefined()
    expect(resumeArgv("ses\n1")).toBeUndefined()
  })
  test("herdr's rules: a plain command name, no apostrophe or control character, 64 args, 8 KiB", () => {
    expect(validResumeArgv([])).toBe(false)
    expect(validResumeArgv(["/usr/bin/opencode"])).toBe(false)
    expect(validResumeArgv(["opencode", "\u0007"])).toBe(false)
    expect(validResumeArgv(Array.from({ length: 65 }, () => "a"))).toBe(false)
    expect(validResumeArgv(["opencode", "x".repeat(8 * 1024)])).toBe(false)
    expect(validResumeArgv(["opencode", "--model", "a/b"])).toBe(true)
  })
})

describe("params", () => {
  test("a working report carries the session and its resume command", () => {
    expect(agentParams("w1:p1", { state: "working", sessionId: "ses_1", working: "shell: ls" }, 7)).toEqual({
      pane_id: "w1:p1",
      source: "dotfiles:opencode",
      agent: "opencode",
      state: "working",
      seq: 7,
      agent_session_id: "ses_1",
      resume_argv: ["opencode", "-s", "ses_1"],
    })
  })

  test("a blocked report carries its message; an unknown one no session", () => {
    expect(agentParams("p", { state: "blocked", sessionId: "s", message: "Permission: shell" }, 1).message).toBe("Permission: shell")
    expect(agentParams("p", { state: "unknown" }, 1)).toEqual({ pane_id: "p", source: SOURCE, agent: "opencode", state: "unknown", seq: 1 })
  })

  test("metadata sets the title and working label under our guards, with a ttl", () => {
    expect(metadataParams("p", { state: "working", sessionId: "s", title: "Fix login", working: "kernel: go" }, 3)).toEqual({
      pane_id: "p",
      source: SOURCE,
      agent: "opencode",
      applies_to_source: SOURCE,
      seq: 3,
      ttl_ms: METADATA_TTL_MS,
      title: "Fix login",
      state_labels: { working: "kernel: go" },
    })
  })

  test("metadata clears what the activity no longer has", () => {
    const params = metadataParams("p", { state: "idle", sessionId: "s" }, 3)
    expect(params.clear_title).toBe(true)
    expect(params.clear_state_labels).toBe(true)
    expect(params.title).toBeUndefined()
    expect(params.state_labels).toBeUndefined()
  })

  test("release names our source and agent", () =>
    expect(releaseParams("p", 9)).toEqual({ pane_id: "p", source: SOURCE, agent: "opencode", seq: 9 }))
})

describe("changes", () => {
  test("the first activity sends both", () => expect(changes(undefined, { state: "unknown" })).toEqual({ agent: true, metadata: true }))
  test("a new label alone sends metadata only", () => {
    const a = { state: "working" as const, sessionId: "s", working: "shell: a" }
    expect(changes(a, { ...a, working: "shell: b" })).toEqual({ agent: false, metadata: true })
  })
  test("a new state with the same labels sends the state only", () => {
    expect(changes({ state: "idle", sessionId: "s", title: "t" }, { state: "blocked", sessionId: "s", title: "t", message: "Question: x" })).toEqual({
      agent: true,
      metadata: false,
    })
  })
  test("leaving working drops its label", () => {
    expect(changes({ state: "working", sessionId: "s", working: "shell: a" }, { state: "idle", sessionId: "s" })).toEqual({ agent: true, metadata: true })
  })
})
