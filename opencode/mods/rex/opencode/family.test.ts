// The subagents a TUI hands its environment to: the family of the session
// on screen, read from the TUI's data, the session on screen and the root
// aside (the host sets the first, another TUI may show the second), each
// handed over when it appears and when it starts to run again. Bun's tests
// resolve solid-js to its server build, which never re-runs a computation,
// so this file hands the follower the reactive build OpenCode loads.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { createEffect, createRoot, createSignal } from "solid-js/dist/solid.js"
import { followFamily, type Reads, type Route, subagentsOf } from "./family.ts"

/** The TUI's reads over one family under `root`, `running` the members that run. */
const reads = (root: string, members: () => ReadonlyArray<string>, running: () => ReadonlyArray<string>): Reads => ({
  session: {
    root: () => root,
    family: members,
    status: (id) => Option.match(Option.liftPredicate(id, (member) => running().includes(member)), { onNone: () => "idle", onSome: () => "running" }),
  },
})

const onScreen = (sessionID: string): Route => ({ type: "session", sessionID })

describe("the subagents of the family on screen", () => {
  const family = reads("ses_root", () => ["ses_root", "ses_a", "ses_b"], () => ["ses_a"])

  test("from the root's view: every descendant, with whether it runs", () => {
    expect(subagentsOf(family, onScreen("ses_root"))).toEqual([
      { id: "ses_a", running: true },
      { id: "ses_b", running: false },
    ])
  })

  test("from a subagent's view: the others, never the root or the one on screen", () => {
    expect(subagentsOf(family, onScreen("ses_a"))).toEqual([{ id: "ses_b", running: false }])
  })

  test("off a session route, or on the placeholder session, none", () => {
    expect(subagentsOf(family, { type: "home" })).toEqual([])
    expect(subagentsOf(family, onScreen("dummy"))).toEqual([])
  })
})

test("each subagent is handed the environment when it appears and when it starts to run again, not on every change", () => {
  const [members, setMembers] = createSignal<ReadonlyArray<string>>(["ses_root", "ses_a"])
  const [running, setRunning] = createSignal<ReadonlyArray<string>>(["ses_a"])
  const handed: Array<string> = []
  const dispose = createRoot((done) => {
    followFamily(reads("ses_root", members, running), () => onScreen("ses_root"), (id) => handed.push(id), createEffect)
    return done
  })
  expect(handed).toEqual(["ses_a"])
  setMembers(["ses_root", "ses_a", "ses_b"])
  expect(handed).toEqual(["ses_a", "ses_b"])
  setRunning([])
  setRunning(["ses_a"])
  expect(handed).toEqual(["ses_a", "ses_b", "ses_a"])
  dispose()
  setRunning([])
  setRunning(["ses_a", "ses_b"])
  expect(handed).toEqual(["ses_a", "ses_b", "ses_a"])
})
