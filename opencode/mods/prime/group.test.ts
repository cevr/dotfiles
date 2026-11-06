// The fx-style tool group's words, from calls as OpenCode stores them.
import { describe, expect, test } from "bun:test"
import { BURST_MS } from "./burst.ts"
import { canonical, toolInput, type Call } from "./call.ts"
import {
  alone,
  branch,
  callBody,
  entryCalls,
  entryKey,
  failureRuns,
  followsGroup,
  groupEntries,
  groupHeader,
  groupLead,
  groupRun,
  groupShows,
  hasBody,
  headerRuns,
  levelNodes,
  levelRows,
  listed,
  nodeOwner,
  rowEnding,
  rows,
  subject,
  thinking,
  thoughtLine,
  toolRun,
  verb,
} from "./group.ts"
import { noticeApart, noticeBurst, noticeGroup, noticeLines, noticeResult } from "./notice.ts"
import type { AssistantMessage, Fields, Message, Part, SyntheticMessage, ToolPart, ToolState } from "./session.ts"

let ids = 0
function call(
  name: string,
  input: Fields,
  state: "completed" | "running" | "error" = "completed",
  metadata: Fields = {},
): ToolPart {
  const id = `call_${++ids}`
  const time = { created: 0, ...(state === "running" ? {} : { completed: 1 }) }
  if (state === "running") return { type: "tool", id, name, time, state: { status: "running", input, metadata: {} } }
  if (state === "error")
    return {
      type: "tool",
      id,
      name,
      time,
      state: { status: "error", input, error: { type: "tool.error", message: "File not found: x.md" } },
    }
  return { type: "tool", id, name, time, state: { status: "completed", input, content: [], metadata } }
}
/** A call the turn's interrupt cut short, as the host ends it. */
function cut(name: string, input: Fields, type = "aborted"): ToolPart {
  const part = call(name, input, "error")
  return { ...part, state: { status: "error", input, error: { type, message: "Tool execution aborted" } } }
}
/** The call `part` with its state changed to `state`. */
const restated = (part: ToolPart, state: (input: Fields, metadata: Fields) => ToolState): ToolPart => ({
  ...part,
  state: state(toolInput(part), part.state.status === "completed" ? (part.state.metadata ?? {}) : {}),
})
/** A model step of `content`, made at `created`. */
const step = (id: string, content: ReadonlyArray<Part>, time: AssistantMessage["time"] = { created: 0 }): AssistantMessage => ({
  type: "assistant",
  id,
  time,
  content,
})
const user = (id: string, text: string): Message => ({ type: "user", id, text, time: { created: 0 } })
const calls = (...parts: ToolPart[]): Call[] => parts.map((part) => ({ tool: canonical(part.name), part }))
const words = (list: Call[]) => headerRuns(list).map((run) => run.text).join("")
const edit = (path: string, additions: number, deletions: number) =>
  call("apply_patch", { patchText: "" }, "completed", { files: [{ relativePath: path, patch: "", additions, deletions }] })

describe("the group header", () => {
  test("names each kind once, the largest count first, capitalising only the first phrase", () => {
    const list = calls(
      call("bash", { command: "ls" }),
      call("read", { path: "a.ts" }),
      call("read", { path: "b.ts" }),
      call("read", { path: "c.ts" }),
      call("bash", { command: "pwd" }),
      call("grep", { pattern: "TODO" }),
      edit("a.ts", 1, 1),
    )
    expect(words(list)).toBe("Read 3 files · ran 2 commands · searched 1 pattern · edited 1 file")
  })

  test("puts the kinds still running last, in the running tense", () => {
    expect(words(calls(call("read", { path: "a.ts" }), call("bash", { command: "sleep 20" }, "running")))).toBe(
      "Read 1 file · running 1 command",
    )
  })

  test("ends with the failures, drawn in the error tone; a failed call still counts in its kind", () => {
    const runs = headerRuns(calls(call("read", { path: "a.ts" }), call("read", { path: "x.md" }, "error")))
    expect(runs.map((run) => run.text).join("")).toBe("Read 2 files · 1 failed")
    expect(runs.at(-1)).toEqual({ text: "1 failed", tone: "error" })
  })

  test("names the background-shell tools, and their rows by the shell", () => {
    const list = calls(
      call("shell_list", {}),
      call("shell_read", { id: "sh_1", lines: 40 }),
      call("shell_read", { id: "sh_2" }),
      call("shell_kill", { id: "sh_1" }),
    )
    expect(words(list)).toBe("Read 2 shell outputs · listed shells · killed 1 command")
    expect(rows(list).map((row) => `${verb(row)} ${subject(row)}`.trim())).toEqual([
      "Listed shells",
      "Read sh_1, sh_2",
      "Killed sh_1",
    ])
  })

  test("names a shell call by its action: a background start, a list, and a check, wait and kill on a handle", () => {
    const list = calls(
      call("shell", { command: "bun dev", background: true }, "completed", { id: "sh_1", state: "running", backgrounded: "start" }),
      call("shell", { action: "list" }),
      call("shell", { action: "check", id: "sh_1", lines: 5 }),
      call("shell", { action: "wait", id: "sh_1", ms: 500 }),
      call("shell", { action: "kill", id: "sh_1" }),
      call("shell", { action: "run", command: "ls" }),
    )
    expect(words(list)).toBe(
      "Started 1 command in the background · listed shells · checked 1 shell · waited on 1 shell · killed 1 shell · ran 1 command",
    )
    expect(rows(list).map((row) => `${verb(row)} ${subject(row)}`.trim())).toEqual([
      "Started bun dev in the background",
      "Listed shells",
      "Checked sh_1",
      "Waited on sh_1",
      "Killed sh_1",
      "Ran ls",
    ])
    // Still running, each says so in the running tense.
    expect(rows(calls(call("shell", { action: "wait", id: "sh_1" }, "running"))).map(verb)).toEqual(["Waiting on"])
  })

  test("an older transcript's shell flag forms read as their actions", () => {
    const list = calls(
      call("shell", { list: true }),
      call("shell", { id: "sh_1", lines: 5 }),
      call("shell", { id: "sh_1", wait: 500 }),
      call("shell", { id: "sh_1", kill: true }),
    )
    expect(words(list)).toBe("Listed shells · checked 1 shell · waited on 1 shell · killed 1 shell")
    expect(rows(list).map((row) => `${verb(row)} ${subject(row)}`.trim())).toEqual([
      "Listed shells",
      "Checked sh_1",
      "Waited on sh_1",
      "Killed sh_1",
    ])
    expect(rows(calls(call("shell", { id: "sh_1", wait: 500 }, "running"))).map(verb)).toEqual(["Waiting on"])
  })

  test("a shell row's output drops the handle header its result leads with", () => {
    const part = call("shell", { command: "ls" }, "completed", { id: "sh_1", state: "exited", exitCode: 0 })
    const done = { ...part, state: { ...part.state, content: [{ type: "text", text: "sh_1 · exited 0 · 0.2 s" }, { type: "text", text: "a.ts" }] } } as ToolPart
    expect(callBody({ tool: "shell", part: done }).output).toBe("a.ts")
    // A kernel cell's record joins the parts into one text.
    const joined = { ...part, state: { ...part.state, content: [{ type: "text", text: "sh_1 · exited 0 · 0.2 s\na.ts" }] } } as ToolPart
    expect(callBody({ tool: "shell", part: joined }).output).toBe("a.ts")
  })

  test("counts an edit's files, and names an unknown tool by its id", () => {
    expect(words(calls(call("apply_patch", { patchText: "" }, "completed", { files: [{ relativePath: "a", patch: "" }, { relativePath: "b", patch: "" }] })))).toBe(
      "Edited 2 files",
    )
    expect(words(calls(call("todowrite", {}), call("todowrite", {})))).toBe("todowrite 2×")
  })
})

describe("cancels and width, as gent's activityHeaderRuns", () => {
  test("a cut call is no failure: the header counts it as cancelled, in the warning tone, and its row stands alone", () => {
    const list = calls(call("read", { path: "a.ts" }), cut("bash", { command: "sleep 9" }), cut("bash", { command: "sleep 8" }, "tool.interrupted"))
    const runs = headerRuns(list)
    expect(runs.map((run) => run.text).join("")).toBe("Ran 2 commands · read 1 file · 2 cancelled")
    expect(runs.at(-1)).toEqual({ text: "2 cancelled", tone: "warning" })
    const tree = rows(list)
    expect(tree.map((row) => row.outcome)).toEqual(["done", "cancelled", "cancelled"])
    const [, second] = tree
    expect(second && rowEnding(second)).toEqual({ text: "cancelled", tone: "warning" })
  })

  test("a command the host moved to the background says so, muted; a run of commands counts them", () => {
    const moved = call("shell", { command: "sleep 600" }, "completed", { backgrounded: "limit" })
    const [alone] = rows(calls(moved))
    expect(alone && rowEnding(alone)).toEqual({ text: "moved to the background", tone: "muted" })
    const [run] = rows(
      calls(
        call("shell", { command: "bun dev" }, "completed", { backgrounded: "user" }),
        call("shell", { command: "ls" }),
        call("shell", { command: "sleep 9" }, "completed", { backgrounded: "limit" }),
      ),
    )
    expect(run && rowEnding(run)).toEqual({ text: "2 moved to the background", tone: "muted" })
    // An explicit background start is no move; nor is an ordinary run.
    const [started] = rows(calls(call("shell", { command: "bun dev", background: true }, "completed", { background: true })))
    expect(started && rowEnding(started)).toBeUndefined()
    // It is no failure: the overview leaves it out.
    expect(levelRows(calls(moved), "overview")).toEqual([])
  })

  test("narrow, kinds drop from the right; the first kind and the failures stay", () => {
    const list = calls(
      call("read", { path: "a.ts" }),
      call("read", { path: "b.ts" }),
      call("bash", { command: "ls" }),
      call("grep", { pattern: "x" }),
      call("read", { path: "x.md" }, "error"),
    )
    const at = (width: number) => headerRuns(list, width).map((run) => run.text).join("")
    expect(at(200)).toBe("Read 3 files · ran 1 command · searched 1 pattern · 1 failed")
    expect(at(40)).toBe("Read 3 files · ran 1 command · 1 failed")
    expect(at(10)).toBe("Read 3 files · 1 failed")
  })

  test("a row's subjects fit the width, then +N counts the rest; the first always shows", () => {
    expect(listed(["a.ts", "b.ts", "c.ts"])).toBe("a.ts, b.ts, c.ts")
    expect(listed(["a.ts", "b.ts", "c.ts"], 13)).toBe("a.ts, b.ts +1")
    expect(listed(["a-long-name.ts", "b.ts"], 4)).toBe("a-long-name.ts +1")
    const reads = rows(calls(call("read", { path: "a.ts" }), call("read", { path: "b.ts" }), call("read", { path: "c.ts" })))
    const [first] = reads
    expect(first && subject(first, 13)).toBe("a.ts, b.ts +1")
  })

  test("a failure's collapsed line: verb and subject, its ending, then the reason while it fits", () => {
    const [failed] = rows(calls(call("read", { path: "x.md" }, "error")))
    expect(failed).toBeDefined()
    if (!failed) return
    const line = (width?: number) => failureRuns(failed, width).map((run) => run.text).join("")
    expect(line()).toBe("Read x.md · failed · File not found: x.md")
    expect(line(28)).toBe("Read x.md · failed · File n…")
    expect(line(18)).toBe("Read x.md · failed")
    expect(failureRuns(failed).find((run) => run.text === "failed")?.tone).toBe("error")
    const [exited] = rows(calls(call("bash", { command: "pytest" }, "completed", { exit: 1 })))
    expect(exited && failureRuns(exited).map((run) => run.text).join("")).toBe("Ran pytest · exit 1")
  })
})

describe("the tree rows", () => {
  test("fold calls to one tool with one outcome; a failure and a nonzero exit stand alone", () => {
    const list = calls(
      call("read", { path: "a.ts" }),
      call("read", { path: "b.ts" }),
      call("read", { path: "x.md" }, "error"),
      call("bash", { command: "pytest" }, "completed", { exit: 1 }),
      call("bash", { command: "pytest -x" }, "completed", { exit: 2 }),
    )
    const tree = rows(list)
    expect(tree.map((row) => `${verb(row)} ${subject(row)} [${row.outcome}]`)).toEqual([
      "Read a.ts, b.ts [done]",
      "Read x.md [failed]",
      "Ran pytest [warning]",
      "Ran pytest -x [warning]",
    ])
    const [row] = tree
    const [owner] = list
    expect(row?.owner).toBe(owner?.part.id)
  })

  test("a background subagent call reads as started, and does not fold with a foreground one", () => {
    const list = calls(
      call("subagent", { description: "fix-a", prompt: "A", background: true }),
      call("subagent", { description: "fix-b", prompt: "B", background: true }),
      call("subagent", { description: "review", prompt: "R" }),
    )
    expect(words(list)).toBe("Started 2 agents · ran 1 agent")
    expect(rows(list).map((row) => `${verb(row)} ${subject(row)}`)).toEqual(["Started fix-a", "Started fix-b", "Ran review"])
  })

  test("a running call reads in the running tense; a subagent names its agent and task", () => {
    const tree = rows(calls(call("task", { agent: "code-reviewer", prompt: "Review the diff." }, "running")))
    const [row] = tree
    expect(row && `${verb(row)} ${subject(row)}`).toBe("Running code-reviewer · Review the diff.")
  })

  test("a subagent with a description reads as that description alone, without its prompt", () => {
    const tree = rows(calls(call("subagent", { agent: "general", description: "Fix money parsing", prompt: "Task 1: a long brief." })))
    const [row] = tree
    expect(row && `${verb(row)} ${subject(row)}`).toBe("Ran Fix money parsing")
  })
})

describe("the tree's connectors and rail, at every level", () => {
  test("rows that rows follow are ├ and keep the rail under their bodies; the last is └ and its body has none", () => {
    expect([0, 1, 2].map((index) => branch(index, 3, false))).toEqual([
      { connector: "├", rail: true },
      { connector: "├", rail: true },
      { connector: "└", rail: false },
    ])
    // Overview's one failure row still hangs under the header.
    expect(branch(0, 1, false)).toEqual({ connector: "└", rail: false })
  })

  test("a row that is the group's line alone has no connector and no rail", () => {
    expect(branch(0, 1, true)).toEqual({ rail: false })
  })
})

describe("what hangs under a call at the all level", () => {
  /** A finished call with `output` as its text content. */
  const said = (part: ToolPart, output: string) =>
    restated(part, (input, metadata) => ({ status: "completed", input, metadata, content: [{ type: "text", text: output }] }))
  const one = (part: ToolPart): Call => ({ tool: canonical(part.name), part })
  const patch = one(said(edit("src/net.py", 1, 1), "Success. Updated src/net.py"))
  const reply = one(said(call("task", { agent: "code-reviewer", prompt: "Review." }), "Approved."))
  const started = one(said(call("subagent", { description: "fix-a", prompt: "A", background: true }), "Started."))
  const missing = one(call("read", { path: "x.md" }, "error"))

  test("a patch hangs its files' diffs, never its output", () => {
    const body = callBody(patch)
    expect(body.files.map((file) => file.path)).toEqual(["src/net.py"])
    expect(body.output).toBe("")
    expect(hasBody(body)).toBe(true)
  })

  test("a foreground agent that finished hangs its Agent message line and its reply; a background launch only its output", () => {
    expect(callBody(reply)).toEqual({ files: [], reply: true, output: "Approved." })
    expect(callBody(started)).toEqual({ files: [], reply: false, output: "Started." })
  })

  test("a failed read with no output hangs nothing, so no rail is drawn under it", () => {
    expect(hasBody(callBody(missing))).toBe(false)
  })
})

describe("a run, as one step's group", () => {
  const ids = (run: Call[]) => run.map((item) => item.part.id)

  test("is one step's calls: reasoning and blank text between them do not end it, the step's edge does", () => {
    const [a, b, c, d] = [call("read", { path: "a" }), call("bash", { command: "ls" }), call("read", { path: "c" }), call("read", { path: "d" })]
    const messages = [
      step("m1", [{ type: "text", text: "Looking." }, a, { type: "reasoning", text: "Next the tests." }, { type: "text", text: " " }, b]),
      step("m2", [{ type: "reasoning", text: "Run them." }, c, d]),
    ]
    for (const [at, part] of [[0, a], [0, b]] as const) expect(ids(toolRun(messages, at, part.id))).toEqual([a.id, b.id])
    for (const [at, part] of [[1, c], [1, d]] as const) expect(ids(toolRun(messages, at, part.id))).toEqual([c.id, d.id])
    expect(toolRun(messages, 0, "text:0")).toEqual([])
  })

  test("answer text, a prompt or a notice ends it", () => {
    const [a, b, c] = [call("read", { path: "a" }), call("read", { path: "b" }), call("read", { path: "c" })]
    const messages = [
      step("m1", [a, { type: "text", text: "Found it." }, b]),
      user("u1", "go on"),
      step("m2", [c]),
    ]
    expect(ids(toolRun(messages, 0, a.id))).toEqual([a.id])
    expect(ids(toolRun(messages, 0, b.id))).toEqual([b.id])
    expect(ids(toolRun(messages, 2, c.id))).toEqual([c.id])
  })
})

describe("a message between two calls starts a new group", () => {
  const ids = (run: Call[]) => run.map((item) => item.part.id)

  test("a one-line intermediate text in the next step splits the calls into two groups", () => {
    const [a, b] = [call("bash", { command: "pytest" }), call("apply_patch", { patchText: "" })]
    const messages = [step("m1", [a]), step("m2", [{ type: "text", text: "Patching it." }, b])]
    expect(ids(groupRun(messages, "m1", a.id))).toEqual([a.id])
    expect(ids(groupRun(messages, "m2", b.id))).toEqual([b.id])
  })

  test("a user message, a steer, a synthetic notice or a compaction between calls splits them", () => {
    const between: Message[] = [
      { type: "user", id: "x", text: "also read the notes", time: { created: 0 } },
      { type: "synthetic", id: "x", text: "Shell finished", metadata: { source: "shell" }, time: { created: 0 } },
      { type: "synthetic", id: "x", text: "Notice", metadata: { source: "subagent", state: "completed" }, time: { created: 0 } },
      { type: "compaction", id: "x", status: "completed", reason: "auto", summary: "", time: { created: 0 } },
    ]
    for (const message of between) {
      const [a, b] = [call("read", { path: "a" }), call("read", { path: "b" })]
      const messages = [step("m1", [a]), message, step("m2", [b])]
      expect(ids(groupRun(messages, "m1", a.id))).toEqual([a.id])
      expect(ids(groupRun(messages, "m2", b.id))).toEqual([b.id])
    }
  })

  test("a step's parallel calls share one group; the next step starts its own, with nothing drawn between", () => {
    const [a, b, c] = [call("read", { path: "a" }), call("bash", { command: "ls" }), call("bash", { command: "pwd" })]
    const messages = [step("m1", [a, b]), step("m2", [{ type: "reasoning", text: "Now the listing." }, c])]
    expect(ids(groupRun(messages, "m1", b.id))).toEqual([a.id, b.id])
    expect(words(groupRun(messages, "m1", a.id))).toBe("Read 1 file · ran 1 command")
    expect(ids(groupRun(messages, "m2", c.id))).toEqual([c.id])
  })

  test("each kernel cell, one per step, is a group of its own, the running one the newest", () => {
    const cell = (status: "completed" | "running", command: string) => {
      const operations = [{ tool: "shell", status, input: { command } }]
      return restated(call("kernel", { code: "await tools.shell({})" }), (input) =>
        status === "running" ? { status, input, metadata: { operations } } : { status, input, content: [], metadata: { operations } },
      )
    }
    const [first, second, live] = [cell("completed", "git status"), cell("completed", "bun test"), cell("running", "bun run gate")]
    const messages = [step("m1", [first]), step("m2", [second]), step("m3", [{ type: "reasoning", text: "Gate." }, live])]
    expect(groupRun(messages, "m1", first.id).map((item) => toolInput(item.part).command)).toEqual(["git status"])
    expect(groupRun(messages, "m2", second.id).map((item) => toolInput(item.part).command)).toEqual(["bun test"])
    const run = groupRun(messages, "m3", live.id)
    expect(rows(run).map((row) => `${verb(row)} ${subject(row)} [${row.outcome}]`)).toEqual(["Running bun run gate [running]"])
  })

  test("a running call after text is a group of its own: its row is the group's line, in the running tense", () => {
    const [a, long] = [call("bash", { command: "printf ok" }), call("bash", { command: "sleep 600" }, "running")]
    const messages = [step("m1", [a]), step("m2", [{ type: "text", text: "Running the long suite." }, long])]
    const run = groupRun(messages, "m2", long.id)
    expect(ids(run)).toEqual([long.id])
    const tree = rows(run)
    expect(tree.map((row) => `${verb(row)} ${subject(row)} [${row.outcome}]`)).toEqual(["Running sleep 600 [running]"])
    // One row is the group's line: no header above it and no connector before it.
    expect(branch(0, tree.length, true)).toEqual({ rail: false })
    // The earlier group keeps only its own call; the running one is not drawn under it.
    expect(ids(groupRun(messages, "m1", a.id))).toEqual([a.id])
  })
})

describe("the blank row between groups", () => {
  const assistant = (id: string, content: ReadonlyArray<Part>) => step(id, content)
  const [a, b, c] = [call("read", { path: "a" }), call("bash", { command: "ls" }), call("read", { path: "c" })]

  test("opens a group whose row above is another step's call", () => {
    const messages = [assistant("m1", [{ type: "text", text: "Looking." }, a]), assistant("m2", [b])]
    expect(followsGroup(messages, "m2", b.id)).toBe(true)
  })

  test("not after prose, a user message, or empty text that draws nothing", () => {
    expect(followsGroup([assistant("m1", [{ type: "text", text: "Looking." }, a])], "m1", a.id)).toBe(false)
    expect(followsGroup([user("u1", "go"), assistant("m2", [b])], "m2", b.id)).toBe(false)
    const messages = [assistant("m1", [a, { type: "text", text: "  " }]), assistant("m2", [{ type: "reasoning", text: "" }, b])]
    expect(followsGroup(messages, "m2", b.id)).toBe(true)
  })

  test("within a message, a run after another run's calls opens apart", () => {
    const messages = [assistant("m1", [a, { type: "text", text: "" }, c])]
    expect(followsGroup(messages, "m1", c.id)).toBe(true)
    expect(followsGroup(messages, "m1", a.id)).toBe(false)
  })
})

describe("subagent launches across steps", () => {
  const launchStep = (id: string, created: number, content: ReadonlyArray<Part>) =>
    step(id, content, { created, completed: created + 500 })
  const launch = (description: string) =>
    call("subagent", { agent: "general", description, prompt: "A long brief.", background: true })

  test("steps that only start agents, close in time, read as one group with a row per agent", () => {
    const [a, b, c] = [launch("fix-a"), launch("fix-b"), launch("fix-c")]
    const messages = [
      launchStep("m1", 0, [a]),
      launchStep("m2", 3_000, [{ type: "reasoning", text: "" }, b]),
      launchStep("m3", 6_000, [c]),
    ]
    for (const [id, part] of [["m1", a], ["m2", b], ["m3", c]] as const)
      expect(groupRun(messages, id, part.id).map((item) => item.part.id)).toEqual([a.id, b.id, c.id])
    const run = groupRun(messages, "m3", c.id)
    expect(words(run)).toBe("Started 3 agents")
    expect(rows(run).map((row) => `${verb(row)} ${subject(row)}`)).toEqual(["Started fix-a", "Started fix-b", "Started fix-c"])
  })

  test("a pause past the window, prose, shown reasoning or another call keeps launch steps apart", () => {
    const [a, b] = [launch("fix-a"), launch("fix-b")]
    const apart = (second: ReadonlyArray<Part>, at = 3_000) =>
      groupRun([launchStep("m1", 0, [a]), launchStep("m2", at, second)], "m1", a.id).map((item) => item.part.id)
    expect(apart([b], 500 + BURST_MS + 1)).toEqual([a.id])
    expect(apart([{ type: "text", text: "Now the CSV fix." }, b])).toEqual([a.id])
    expect(apart([{ type: "reasoning", text: "The CSV fix is separate." }, b])).toEqual([a.id])
    expect(apart([b, call("read", { path: "a.ts" })])).toEqual([a.id])
    expect(apart([b])).toEqual([a.id, b.id])
  })

  test("only launch steps join across steps: other calls, and a launch beside them, keep to their step", () => {
    const [a, b] = [call("read", { path: "a" }), call("read", { path: "b" })]
    expect(groupRun([launchStep("m1", 0, [a]), launchStep("m2", 1_000, [b])], "m2", b.id).map((item) => item.part.id)).toEqual([b.id])
    const started = launch("fix-a")
    const read = call("read", { path: "c" })
    expect(groupRun([launchStep("m1", 0, [started]), launchStep("m2", 1_000, [read])], "m2", read.id).map((item) => item.part.id)).toEqual([read.id])
    const foreground = call("subagent", { description: "review", prompt: "R" })
    const later = launch("fix-a")
    expect(groupRun([launchStep("m1", 0, [foreground]), launchStep("m2", 1_000, [later])], "m2", later.id)).toHaveLength(1)
  })
})

describe("completion notices", () => {
  const done = (id: string, created: number, description: string, metadata: Fields = {}): SyntheticMessage => ({
      type: "synthetic",
      id,
      text: "Notice",
      description,
      metadata: { source: "subagent", state: "completed", agent: "worker", childID: `ses_${id}`, ...metadata },
      time: { created },
    })
  const ids = (burst: ReadonlyArray<{ id: string }>) => burst.map((message) => message.id)

  test("finished workers next to each other, close in time, fold into the first notice", () => {
    const messages = [done("n1", 0, "fix-a"), done("n2", 2_000, "fix-b"), done("n3", 4_000, "fix-c")]
    expect(ids(noticeBurst(messages, "n1"))).toEqual(["n1", "n2", "n3"])
    expect(ids(noticeBurst(messages, "n3"))).toEqual(["n1", "n2", "n3"])
    const group = noticeGroup(messages, "n1")!
    expect(group.drawn).toBe(true)
    expect(noticeGroup(messages, "n2")!.drawn).toBe(false)
    expect(group.header.map((run) => run.text).join("")).toBe("3 agents finished")
    // A node per worker, each opening its own session.
    expect(group.nodes.map((node) => [node.label, node.child])).toEqual([
      ["fix-a", "ses_n1"],
      ["fix-b", "ses_n2"],
      ["fix-c", "ses_n3"],
    ])
  })

  test("a failure, a shell, a pause or a row between stands alone", () => {
    const failed = done("n2", 1_000, "fix-b", { state: "error" })
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), failed], "n1"))).toEqual(["n1"])
    expect(noticeBurst([done("n1", 0, "fix-a"), failed], "n2")).toEqual([])
    const shell = done("n2", 1_000, "bun test", { source: "shell" })
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), shell], "n1"))).toEqual(["n1"])
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), done("n2", BURST_MS + 1, "fix-b")], "n2"))).toEqual(["n2"])
    const text = step("m1", [{ type: "text", text: "One down." }], { created: 500 })
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), text, done("n2", 1_000, "fix-b")], "n2"))).toEqual(["n2"])
  })
})

describe("a notice as a tool-call group", () => {
  const notice = (id: string, text: string, metadata: Fields, description = "Fix money parsing"): SyntheticMessage => ({
    type: "synthetic",
    id,
    text,
    description,
    metadata,
    time: { created: 0 },
  })
  const envelope = (state: string, body: string) =>
    `<subagent sessionID="ses_1" state="${state}" description="Fix money parsing">\n${body}\n</subagent>`
  const worker = (state: string, body: string, id = "n1") =>
    notice(id, envelope(state, body), { source: "subagent", state, agent: "worker", childID: `ses_${id}` })
  const header = (group: ReturnType<typeof noticeGroup>) => group!.header.map((run) => run.text).join("")
  const drawn = (lines: ReturnType<typeof noticeLines>) => lines.map((line) => `${line.lead} ${line.runs.map((run) => run.text).join("")}`)

  test("its answer is what the envelope holds", () => {
    expect(noticeResult(envelope("completed", "Fixed.\nAll green."))).toBe("Fixed.\nAll green.")
    expect(noticeResult(`The following shell command was executed by the user:\n<shell id="s" state="completed" command="ls">\na\nb\n</shell>`)).toBe("a\nb")
    expect(noticeResult("User shell command failed to start:\nls")).toBe("User shell command failed to start:\nls")
  })

  test("a finished worker reads as a group: a muted ● header naming it and its task, its answer the tree", () => {
    const group = noticeGroup([worker("completed", "Fixed money parsing.\nAll green.")], "n1")!
    expect(group.glyph).toEqual({ char: "●", tone: "muted" })
    expect(header(group)).toBe("Worker finished · Fix money parsing")
    expect(group.header.map((run) => run.tone)).toEqual(["muted", "muted", "muted"])
    expect(group.child).toBe("ses_n1")
    expect(drawn(noticeLines(group, "details"))).toEqual(["└ Fixed money parsing.", "  All green."])
    // The overview keeps the header alone, as a group that ended well.
    expect(noticeLines(group, "overview")).toEqual([])
  })

  test("a failure and a cancel say so in their tone, the glyph too, and keep their reason at the overview", () => {
    const failed = noticeGroup([worker("error", "Subagent failed")], "n1")!
    expect(failed.glyph).toEqual({ char: "✗", tone: "error" })
    expect(header(failed)).toBe("Worker failed · Fix money parsing")
    expect(failed.header[1]).toEqual({ text: "failed", tone: "error" })
    expect(drawn(noticeLines(failed, "overview"))).toEqual(["└ Subagent failed"])
    const cancelled = noticeGroup([worker("cancelled", "Subagent cancelled")], "n1")!
    expect(cancelled.glyph).toEqual({ char: "●", tone: "warning" })
    expect(cancelled.header[1]).toEqual({ text: "cancelled", tone: "warning" })
    const shell = noticeGroup([notice("s1", "<shell id=\"s\" state=\"error\" command=\"bun test\">\n1 fail\n</shell>", { source: "shell", state: "error" }, "bun test")], "s1")!
    expect(header(shell)).toBe("Shell failed · bun test")
  })

  test("below All a long answer shows its head and counts the rest; All shows it whole", () => {
    const body = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n")
    const group = noticeGroup([worker("completed", body)], "n1")!
    expect(drawn(noticeLines(group, "details"))).toEqual([
      "└ line 1",
      "  line 2",
      "  line 3",
      "  line 4",
      "  line 5",
      "  … +4 lines (ctrl+o)",
    ])
    expect(noticeLines(group, "details").at(-1)!.runs[0]!.tone).toBe("faint")
    expect(noticeLines(group, "all")).toHaveLength(9)
  })

  test("a burst is a node per worker: its task, then its answer's first line, faint; All hangs the rest beside the rail", () => {
    const messages = [worker("completed", "A done.\nmore", "n1"), worker("completed", "B done.", "n2")]
    const group = noticeGroup(messages, "n1")!
    expect(drawn(noticeLines(group, "details"))).toEqual(["├ Fix money parsing · A done.", "└ Fix money parsing · B done."])
    expect(noticeLines(group, "details")[0]!.runs.map((run) => run.tone)).toEqual(["muted", "faint"])
    expect(noticeLines(group, "details").map((line) => line.child)).toEqual(["ses_n1", "ses_n2"])
    expect(drawn(noticeLines(group, "all"))).toEqual(["├ Fix money parsing · A done.", "│ more", "└ Fix money parsing · B done."])
  })

  test("a notice right under another notice's group opens a blank row; one under anything else does not", () => {
    const shell = notice("s1", "<shell id=\"s\" state=\"completed\" command=\"ls\">\nok\n</shell>", { source: "shell", state: "completed" }, "ls")
    expect(noticeApart([shell, worker("completed", "ok")], "n1")).toBe(true)
    expect(noticeApart([step("m1", [{ type: "text", text: "Waiting." }]), worker("completed", "ok")], "n1")).toBe(false)
    // A folded notice's group is drawn by the burst's first, which looks above the burst.
    expect(noticeApart([worker("completed", "a", "n1"), worker("completed", "b", "n2")], "n2")).toBe(false)
  })
})

describe("thoughts as nodes of their step's tree", () => {
  const thought = (text: string, completed?: number): Part => ({
    type: "reasoning",
    text,
    time: { created: 0, ...(completed === undefined ? {} : { completed }) },
  })
  /** Each node as a line: `thinking <first line>` or `<verb> <subject>`. */
  const tree = (entries: ReturnType<typeof groupEntries>, detail: "overview" | "details" | "all" = "details") => {
    const nodes = levelNodes(entries, detail)
    return nodes.map((node, index) => {
      const lead = branch(index, nodes.length, alone(entryCalls(entries), nodes, detail)).connector ?? "●"
      return node.type === "thought" ? `${lead} thinking ${thoughtLine(node.thought.text)}` : `${lead} ${verb(node.row)} ${subject(node.row)}`
    })
  }

  test("a step that thought, then made two calls, is one tree: the thought first, the calls down it", () => {
    const [a, b] = [call("read", { path: "a.ts" }), call("bash", { command: "bun test" })]
    const messages = [step("m1", [thought("**Plan**\nRead a.ts, then test.", 1), a, b], { created: 0, completed: 2 })]
    // Every part of the run draws through the same group: the thought by the host's `reasoning:0`.
    for (const key of ["reasoning:0", a.id, b.id]) expect(groupEntries(messages, "m1", key).map(entryKey)).toEqual(["reasoning:0", a.id, b.id])
    const entries = groupEntries(messages, "m1", "reasoning:0")
    expect(tree(entries)).toEqual(["├ thinking Plan", "├ Read a.ts", "└ Ran bun test"])
    // The header stays the calls' header: a thought is no action it counts.
    expect(groupHeader(entries).map((run) => run.text).join("")).toBe("Read 1 file · ran 1 command")
    expect(levelNodes(entries, "details").map(nodeOwner)).toEqual(["reasoning:0", a.id, b.id])
  })

  test("a step that thought, then answered, is a one-node tree under `Thought`, ending in └; `Thinking` while it streams", () => {
    const done = [step("m1", [thought("Check the test first.", 1), { type: "text", text: "Reading it." }], { created: 0, completed: 2 })]
    const entries = groupEntries(done, "m1", "reasoning:0")
    expect(tree(entries)).toEqual(["└ thinking Check the test first."])
    expect(groupHeader(entries)).toEqual([{ text: "Thought", tone: "muted" }])
    expect(alone([], levelNodes(entries, "details"), "details")).toBe(false)
    const live = [step("m1", [thought("Check the")], { created: 0 })]
    const streaming = groupEntries(live, "m1", "reasoning:0")
    expect(groupHeader(streaming)).toEqual([{ text: "Thinking", tone: "muted" }])
    expect(thinking(streaming)).toBe(true)
    expect(groupLead([], 0, thinking(streaming)).tone).toBe("accent")
    // Answer text ends the run: the text and the thought before it do not join a later call's group.
    const [c] = [call("read", { path: "c" })]
    const after = [step("m1", [thought("Think.", 1), { type: "text", text: "Now reading." }, c], { created: 0, completed: 2 })]
    expect(groupEntries(after, "m1", c.id).map(entryKey)).toEqual([c.id])
  })

  test("a redacted or empty thought draws no node and joins no group", () => {
    const a = call("read", { path: "a" })
    const messages = [step("m1", [thought("[REDACTED]", 1), thought("  ", 1), a], { created: 0, completed: 2 })]
    expect(groupEntries(messages, "m1", "reasoning:0")).toEqual([])
    expect(groupEntries(messages, "m1", "reasoning:1")).toEqual([])
    expect(groupEntries(messages, "m1", a.id).map(entryKey)).toEqual([a.id])
  })

  test("a thought between calls to one tool keeps them apart; the overview shows no thought, and a thought alone not at all", () => {
    const [a, b] = [call("read", { path: "a" }), call("read", { path: "b" })]
    const entries = groupEntries([step("m1", [a, thought("Then b.", 1), b], { created: 0, completed: 2 })], "m1", a.id)
    expect(tree(entries)).toEqual(["├ Read a", "├ thinking Then b.", "└ Read b"])
    expect(tree(entries, "overview")).toEqual([])
    expect(groupShows(entries, "overview")).toBe(true)
    const lone = groupEntries([step("m1", [thought("Hm.", 1)], { created: 0, completed: 2 })], "m1", "reasoning:0")
    expect(groupShows(lone, "overview")).toBe(false)
    expect(groupShows(lone, "details")).toBe(true)
  })

  test("a group after another step's thought opens with a blank row, as after its calls", () => {
    const a = call("read", { path: "a" })
    const messages = [step("m1", [thought("Hm.", 1)]), step("m2", [thought("Next.", 1), a])]
    expect(followsGroup(messages, "m2", "reasoning:0")).toBe(true)
    expect(followsGroup([user("u1", "go"), messages[1]!], "m2", "reasoning:0")).toBe(false)
  })

  test("the folded line is the thought's first line with words", () => {
    expect(thoughtLine("\n\n**Weighing it**\n\nThe loop exits early.")).toBe("Weighing it")
    expect(thoughtLine("[REDACTED]")).toBe("")
  })
})

describe("a latched subagent call", () => {
  const latchedCall = () =>
    call("subagent", { agent: "worker", description: "Fix money parsing", prompt: "Brief." }, "completed", { sessionID: "ses_c", status: "latched" })

  test("reads as latched, not ran, and hangs no reply", () => {
    const part = latchedCall()
    const run: Call[] = [{ tool: "subagent", part }]
    expect(headerRuns(run).map((item) => item.text).join("")).toBe("Latched 1 agent")
    expect(rows(run).map((row) => `${verb(row)} ${subject(row)}`)).toEqual(["Latched Fix money parsing"])
    expect(callBody(run[0]!).reply).toBe(false)
  })

  test("joins the launches next to it, as a background start does", () => {
    const launch = call("subagent", { agent: "general", description: "fix-a", prompt: "A.", background: true })
    const part = latchedCall()
    const messages = [step("m1", [launch], { created: 0, completed: 500 }), step("m2", [part], { created: 1_000, completed: 1_500 })]
    expect(groupRun(messages, "m2", part.id).map((item) => item.part.id)).toEqual([launch.id, part.id])
    expect(headerRuns(groupRun(messages, "m2", part.id)).map((item) => item.text).join("")).toBe("Started 1 agent · latched 1 agent")
  })
})
