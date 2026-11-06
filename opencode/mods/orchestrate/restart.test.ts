import { describe, expect, test } from "bun:test"
import {
  BACKOFF_MS,
  callCut,
  callTo,
  type Entry,
  ending,
  gaveUp,
  inWindow,
  notice,
  RESUME_PROMPT,
  resumePrompt,
  resumes,
  toldSince,
  verdict,
  WINDOW_MS,
} from "./restart.ts"

const prompt = (at: number, text = "Write the export."): Entry => ({ type: "prompt", at, text })
const step = (at: number, options: { aborted?: boolean; calls?: Array<{ child: string; interrupted: boolean }>; id?: string } = {}): Entry => ({
  type: "assistant",
  id: options.id ?? `msg_${at}`,
  agent: "build",
  at,
  aborted: options.aborted ?? false,
  calls: (options.calls ?? []).map((call, index) => ({ id: `call-${at}-${index}`, ...call })),
})
const idle = (at: number, outcome: "succeeded" | "failed" | "interrupted"): Entry => ({ type: "idle", at, outcome })
const notified: Entry = { type: "other" }

describe("how a turn ended", () => {
  test("a step a shutdown aborted, with no turn end after it, is cut; side notices change nothing", () => {
    expect(ending([prompt(1), step(2), step(3, { aborted: true })])).toEqual({ _tag: "Cut", at: 3 })
    // OpenCode's recovery tells a cut session its shell was cancelled, and starts no turn.
    expect(ending([prompt(1), step(3, { aborted: true }), notified])).toEqual({ _tag: "Cut", at: 3 })
  })

  test("an aborted step then an interrupt is interrupted: a user's or a parent's cancel", () => {
    expect(ending([prompt(1), step(3, { aborted: true }), idle(4, "interrupted")])).toEqual({ _tag: "Interrupted", at: 3 })
  })

  test("a turn that ended, still runs, or was continued is settled", () => {
    expect(ending([])).toEqual({ _tag: "Settled" })
    expect(ending([prompt(1), step(2), idle(3, "succeeded")])).toEqual({ _tag: "Settled" })
    expect(ending([prompt(1), step(2)])).toEqual({ _tag: "Settled" })
    expect(ending([prompt(1), step(2, { aborted: true }), idle(3, "failed")])).toEqual({ _tag: "Settled" })
    // Continued: OpenCode's own restart notice, or a prompt (a parent's follow-up, a resume).
    expect(ending([prompt(1), step(2, { aborted: true }), { type: "restarted", at: 3 }])).toEqual({ _tag: "Settled" })
    expect(ending([prompt(1), step(2, { aborted: true }), prompt(3, "go on")])).toEqual({ _tag: "Settled" })
    // An interrupt after a step that was not aborted (a prompt the user stopped before any step) resumes nothing.
    expect(ending([prompt(1), idle(2, "interrupted")])).toEqual({ _tag: "Settled" })
  })

  test("only a turn cut before this start and within the window counts", () => {
    const boot = WINDOW_MS + 10_000
    expect(inWindow({ _tag: "Cut", at: boot - 1 }, boot)).toBe(true)
    expect(inWindow({ _tag: "Interrupted", at: boot - WINDOW_MS }, boot)).toBe(true)
    expect(inWindow({ _tag: "Cut", at: boot - WINDOW_MS - 1 }, boot)).toBe(false)
    // An Escape after this start is the user's.
    expect(inWindow({ _tag: "Cut", at: boot }, boot)).toBe(false)
    expect(inWindow({ _tag: "Settled" }, boot)).toBe(false)
  })
})

describe("whether the parent's call to a child was cut", () => {
  const child = "ses_child"
  const called = step(5, { aborted: true, calls: [{ child, interrupted: true }] })

  test("the parent's call was interrupted and its turn was not: a shutdown, which OpenCode then continued", () => {
    expect(callCut([prompt(1), called, { type: "restarted", at: 9 }, step(10), idle(11, "succeeded")], child, false)).toBe(true)
    expect(callCut([prompt(1), called], child, false)).toBe(true)
  })

  test("the parent's turn was interrupted after the call: the user's Escape, unless a restart cut the parent too", () => {
    const escaped = [prompt(1), called, idle(6, "interrupted")]
    expect(callCut(escaped, child, false)).toBe(false)
    expect(callCut(escaped, child, true)).toBe(true)
  })

  test("a call that finished, or none to the child, was not cut", () => {
    expect(callCut([prompt(1), step(5, { calls: [{ child, interrupted: false }] }), idle(6, "interrupted")], child, true)).toBe(false)
    expect(callCut([prompt(1), step(5, { calls: [{ child: "ses_other", interrupted: true }] })], child, false)).toBe(false)
  })

  test("the last call to the child names the message, the call and the agent that made it", () => {
    const first = step(2, { calls: [{ child, interrupted: false }], id: "msg_a" })
    expect(callTo([prompt(1), first, called, step(7)], child)).toEqual({ messageID: "msg_5", callID: "call-5-0", agent: "build", interrupted: true, index: 2 })
    expect(callTo([prompt(1)], child)).toBeUndefined()
  })
})

describe("resuming", () => {
  test("resumes in a row count the resume prompts since the last other prompt; OpenCode's notices do not break the run", () => {
    expect(resumes([prompt(1)])).toBe(0)
    expect(resumes([prompt(1), step(2, { aborted: true }), prompt(3, resumePrompt), step(4, { aborted: true })])).toBe(1)
    expect(resumes([prompt(1), prompt(3, resumePrompt), { type: "restarted", at: 4 }, prompt(5, `${RESUME_PROMPT} more`)])).toBe(2)
    expect(resumes([prompt(3, resumePrompt), prompt(4, "Now the import.")])).toBe(0)
  })

  test("each resume waits its backoff; past the last, the child is left to its parent", () => {
    expect(BACKOFF_MS.length).toBe(3)
    expect(verdict(0)).toEqual({ _tag: "Resume", attempt: 1, waitMs: BACKOFF_MS[0]! })
    expect(verdict(2)).toEqual({ _tag: "Resume", attempt: 3, waitMs: BACKOFF_MS[2]! })
    expect(verdict(3)).toEqual({ _tag: "GiveUp", attempts: 3 })
    expect(verdict(1, [0])).toEqual({ _tag: "GiveUp", attempts: 1 })
  })

  test("a parent is told about a child once per cut: a notice naming it since the cut counts, and does not end a turn", () => {
    const told: Entry = { type: "told", at: 12, children: ["ses_b"] }
    expect(toldSince([prompt(1), told], "ses_b", 10)).toBe(true)
    expect(toldSince([prompt(1), told], "ses_b", 13)).toBe(false)
    expect(toldSince([prompt(1), told], "ses_c", 10)).toBe(false)
    expect(ending([prompt(1), step(10, { aborted: true }), told])).toEqual({ _tag: "Cut", at: 10 })
  })

  test("the prompt says the restart cut the turn and its shells", () => {
    expect(resumePrompt.startsWith("Your turn ended when OpenCode restarted; continue where you left off.")).toBe(true)
    expect(resumePrompt).toContain("shell")
  })

  test("the parent's notice names each child resumed and each left, with why", () => {
    const text = notice(
      [{ child: "ses_a", description: "implementor export r1" }],
      [{ child: "ses_b", description: "verifier export r2", why: gaveUp(3) }],
    )
    expect(text).toContain("Resumed in the background: implementor export r1 (sessionID: ses_a).")
    expect(text).toContain("Do not call them to resume them.")
    expect(text).toContain("Not resumed: verifier export r2 (sessionID: ses_b), cut by 3 restarts in a row.")
    expect(notice([], [{ child: "ses_b", description: "b", why: "it could not be resumed: no agent" }])).not.toContain("Resumed in the background")
  })
})
