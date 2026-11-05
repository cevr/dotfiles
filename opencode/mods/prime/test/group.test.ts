// The fx-style tool group's words, from calls as OpenCode stores them.
import { describe, expect, test } from "bun:test"
import {
  BURST_MS,
  branch,
  callBody,
  canonical,
  completionWords,
  failureRuns,
  followsCall,
  groupRun,
  hasBody,
  headerRuns,
  listed,
  noticeBurst,
  rowEnding,
  rows,
  subject,
  toolRun,
  verb,
  type Call,
} from "../src/group"
import { toolInput, type ToolPart } from "../src/view"

let ids = 0
function call(
  name: string,
  input: Record<string, unknown>,
  state: "completed" | "running" | "error" = "completed",
  metadata: Record<string, unknown> = {},
): ToolPart {
  const id = `call_${++ids}`
  const time = { created: 0, ...(state === "running" ? {} : { completed: 1 }) }
  if (state === "running") return { type: "tool", id, name, time, state: { status: "running", input } } as unknown as ToolPart
  if (state === "error")
    return {
      type: "tool",
      id,
      name,
      time,
      state: { status: "error", input, error: { type: "tool.error", message: "File not found: x.md" } },
    } as unknown as ToolPart
  return { type: "tool", id, name, time, state: { status: "completed", input, content: [], metadata } } as unknown as ToolPart
}
/** A call the turn's interrupt cut short, as the host ends it. */
function cut(name: string, input: Record<string, unknown>, type = "aborted"): ToolPart {
  const part = call(name, input, "error") as unknown as { state: Record<string, unknown> }
  return { ...part, state: { ...part.state, error: { type, message: "Tool execution aborted" } } } as unknown as ToolPart
}
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
    expect(rowEnding(tree[1]!)).toEqual({ text: "cancelled", tone: "warning" })
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
    expect(subject(reads[0]!, 13)).toBe("a.ts, b.ts +1")
  })

  test("a failure's collapsed line: verb and subject, its ending, then the reason while it fits", () => {
    const [failed] = rows(calls(call("read", { path: "x.md" }, "error")))
    const line = (width?: number) => failureRuns(failed!, width).map((run) => run.text).join("")
    expect(line()).toBe("Read x.md · failed · File not found: x.md")
    expect(line(28)).toBe("Read x.md · failed · File n…")
    expect(line(18)).toBe("Read x.md · failed")
    expect(failureRuns(failed!).find((run) => run.text === "failed")?.tone).toBe("error")
    const [exited] = rows(calls(call("bash", { command: "pytest" }, "completed", { exit: 1 })))
    expect(failureRuns(exited!).map((run) => run.text).join("")).toBe("Ran pytest · exit 1")
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
    expect(tree[0]!.owner).toBe(list[0]!.part.id)
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
    expect(`${verb(tree[0]!)} ${subject(tree[0]!)}`).toBe("Running code-reviewer · Review the diff.")
  })

  test("a subagent with a description reads as that description alone, without its prompt", () => {
    const tree = rows(calls(call("subagent", { agent: "general", description: "Fix money parsing", prompt: "Task 1: a long brief." })))
    expect(`${verb(tree[0]!)} ${subject(tree[0]!)}`).toBe("Ran Fix money parsing")
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
  const said = (part: ToolPart, output: string) => {
    const done = part as unknown as { state: Record<string, unknown> }
    return { ...done, state: { ...done.state, content: [{ type: "text", text: output }] } } as unknown as ToolPart
  }
  const [patch] = calls(said(edit("src/net.py", 1, 1), "Success. Updated src/net.py"))
  const [reply] = calls(said(call("task", { agent: "code-reviewer", prompt: "Review." }), "Approved."))
  const [started] = calls(said(call("subagent", { description: "fix-a", prompt: "A", background: true }), "Started."))
  const [missing] = calls(call("read", { path: "x.md" }, "error"))

  test("a patch hangs its files' diffs, never its output", () => {
    const body = callBody(patch!)
    expect(body.files.map((file) => file.path)).toEqual(["src/net.py"])
    expect(body.output).toBe("")
    expect(hasBody(body)).toBe(true)
  })

  test("a foreground agent that finished hangs its Agent message line and its reply; a background launch only its output", () => {
    expect(callBody(reply!)).toEqual({ files: [], reply: true, output: "Approved." })
    expect(callBody(started!)).toEqual({ files: [], reply: false, output: "Started." })
  })

  test("a failed read with no output hangs nothing, so no rail is drawn under it", () => {
    expect(hasBody(callBody(missing!))).toBe(false)
  })
})

describe("a run, as one step's group", () => {
  const step = (id: string, content: unknown[]) => ({ type: "assistant", id, time: { created: 0 }, content }) as never
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
      { type: "user", id: "u1", text: "go on" } as never,
      step("m2", [c]),
    ]
    expect(ids(toolRun(messages, 0, a.id))).toEqual([a.id])
    expect(ids(toolRun(messages, 0, b.id))).toEqual([b.id])
    expect(ids(toolRun(messages, 2, c.id))).toEqual([c.id])
  })
})

describe("a message between two calls starts a new group", () => {
  const step = (id: string, content: unknown[]) => ({ type: "assistant", id, time: { created: 0 }, content }) as never
  const ids = (run: Call[]) => run.map((item) => item.part.id)

  test("a one-line intermediate text in the next step splits the calls into two groups", () => {
    const [a, b] = [call("bash", { command: "pytest" }), call("apply_patch", { patchText: "" })]
    const messages = [step("m1", [a]), step("m2", [{ type: "text", text: "Patching it." }, b])]
    expect(ids(groupRun(messages, "m1", a.id))).toEqual([a.id])
    expect(ids(groupRun(messages, "m2", b.id))).toEqual([b.id])
  })

  test("a user message, a steer, a synthetic notice or a compaction between calls splits them", () => {
    const between = [
      { type: "user", id: "x", text: "also read the notes", time: { created: 0 } },
      { type: "synthetic", id: "x", text: "Shell finished", metadata: { source: "shell" }, time: { created: 0 } },
      { type: "synthetic", id: "x", text: "Notice", metadata: { source: "subagent", state: "completed" }, time: { created: 0 } },
      { type: "compaction", id: "x", time: { created: 0 } },
    ]
    for (const message of between) {
      const [a, b] = [call("read", { path: "a" }), call("read", { path: "b" })]
      const messages = [step("m1", [a]), message as never, step("m2", [b])]
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
      const part = call("kernel", { code: "await tools.shell({})" }) as unknown as { state: Record<string, unknown> }
      const operations = [{ tool: "shell", status, input: { command } }]
      return { ...part, state: { ...part.state, status, metadata: { operations } } } as unknown as ToolPart
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
  const assistant = (id: string, content: unknown[]) => ({ type: "assistant", id, content }) as never
  const [a, b, c] = [call("read", { path: "a" }), call("bash", { command: "ls" }), call("read", { path: "c" })]

  test("opens a group whose row above is another step's call", () => {
    const messages = [assistant("m1", [{ type: "text", text: "Looking." }, a]), assistant("m2", [b])]
    expect(followsCall(messages, "m2", b.id)).toBe(true)
  })

  test("not after prose, a user message, or empty text that draws nothing", () => {
    expect(followsCall([assistant("m1", [{ type: "text", text: "Looking." }, a])], "m1", a.id)).toBe(false)
    expect(followsCall([{ type: "user", id: "u1", text: "go" } as never, assistant("m2", [b])], "m2", b.id)).toBe(false)
    const messages = [assistant("m1", [a, { type: "text", text: "  " }]), assistant("m2", [{ type: "reasoning", text: "" }, b])]
    expect(followsCall(messages, "m2", b.id)).toBe(true)
  })

  test("within a message, a run after another run's calls opens apart", () => {
    const messages = [assistant("m1", [a, { type: "text", text: "" }, c])]
    expect(followsCall(messages, "m1", c.id)).toBe(true)
    expect(followsCall(messages, "m1", a.id)).toBe(false)
  })
})

describe("subagent launches across steps", () => {
  const step = (id: string, created: number, content: unknown[]) =>
    ({ type: "assistant", id, time: { created, completed: created + 500 }, content }) as never
  const launch = (description: string) =>
    call("subagent", { agent: "general", description, prompt: "A long brief.", background: true })

  test("steps that only start agents, close in time, read as one group with a row per agent", () => {
    const [a, b, c] = [launch("fix-a"), launch("fix-b"), launch("fix-c")]
    const messages = [
      step("m1", 0, [a]),
      step("m2", 3_000, [{ type: "reasoning", text: "" }, b]),
      step("m3", 6_000, [c]),
    ]
    for (const [id, part] of [["m1", a], ["m2", b], ["m3", c]] as const)
      expect(groupRun(messages, id, part.id).map((item) => item.part.id)).toEqual([a.id, b.id, c.id])
    const run = groupRun(messages, "m3", c.id)
    expect(words(run)).toBe("Started 3 agents")
    expect(rows(run).map((row) => `${verb(row)} ${subject(row)}`)).toEqual(["Started fix-a", "Started fix-b", "Started fix-c"])
  })

  test("a pause past the window, prose, shown reasoning or another call keeps launch steps apart", () => {
    const [a, b] = [launch("fix-a"), launch("fix-b")]
    const apart = (second: unknown[], at = 3_000) =>
      groupRun([step("m1", 0, [a]), step("m2", at, second)], "m1", a.id).map((item) => item.part.id)
    expect(apart([b], 500 + BURST_MS + 1)).toEqual([a.id])
    expect(apart([{ type: "text", text: "Now the CSV fix." }, b])).toEqual([a.id])
    expect(apart([{ type: "reasoning", text: "The CSV fix is separate." }, b])).toEqual([a.id])
    expect(apart([b, call("read", { path: "a.ts" })])).toEqual([a.id])
    expect(apart([b])).toEqual([a.id, b.id])
  })

  test("only launch steps join across steps: other calls, and a launch beside them, keep to their step", () => {
    const [a, b] = [call("read", { path: "a" }), call("read", { path: "b" })]
    expect(groupRun([step("m1", 0, [a]), step("m2", 1_000, [b])], "m2", b.id).map((item) => item.part.id)).toEqual([b.id])
    const started = launch("fix-a")
    const read = call("read", { path: "c" })
    expect(groupRun([step("m1", 0, [started]), step("m2", 1_000, [read])], "m2", read.id).map((item) => item.part.id)).toEqual([read.id])
    const foreground = call("subagent", { description: "review", prompt: "R" })
    const later = launch("fix-a")
    expect(groupRun([step("m1", 0, [foreground]), step("m2", 1_000, [later])], "m2", later.id)).toHaveLength(1)
  })
})

describe("completion notices", () => {
  const done = (id: string, created: number, description: string, metadata: Record<string, unknown> = {}) =>
    ({
      type: "synthetic",
      id,
      text: "Notice",
      description,
      metadata: { source: "subagent", state: "completed", agent: "worker", childID: `ses_${id}`, ...metadata },
      time: { created },
    }) as never
  const ids = (burst: ReadonlyArray<{ id: string }>) => burst.map((message) => message.id)

  test("finished workers next to each other, close in time, fold into the first notice", () => {
    const messages = [done("n1", 0, "fix-a"), done("n2", 2_000, "fix-b"), done("n3", 4_000, "fix-c")]
    expect(ids(noticeBurst(messages, "n1"))).toEqual(["n1", "n2", "n3"])
    expect(ids(noticeBurst(messages, "n3"))).toEqual(["n1", "n2", "n3"])
    expect(completionWords(noticeBurst(messages, "n1"))).toEqual({
      heading: "↳ 3 agents finished",
      suffix: "fix-a, fix-b, fix-c",
    })
  })

  test("a failure, a shell, a pause or a row between stands alone", () => {
    const failed = done("n2", 1_000, "fix-b", { state: "error" })
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), failed], "n1"))).toEqual(["n1"])
    expect(noticeBurst([done("n1", 0, "fix-a"), failed], "n2")).toEqual([])
    const shell = done("n2", 1_000, "bun test", { source: "shell" })
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), shell], "n1"))).toEqual(["n1"])
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), done("n2", BURST_MS + 1, "fix-b")], "n2"))).toEqual(["n2"])
    const text = { type: "assistant", id: "m1", time: { created: 500 }, content: [{ type: "text", text: "One down." }] } as never
    expect(ids(noticeBurst([done("n1", 0, "fix-a"), text, done("n2", 1_000, "fix-b")], "n2"))).toEqual(["n2"])
  })

  test("one notice reads as the host's line, naming its agent", () => {
    expect(completionWords([done("n1", 0, "fix-a")])).toEqual({ heading: "↳ Worker finished", suffix: "fix-a" })
  })
})
