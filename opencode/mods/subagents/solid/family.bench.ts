// What one streamed token costs the TUI's subagent rows in a large family, measured on the
// family read (mods/subagents/solid/reader.ts) and the rows (subagent-row.ts) over a Solid store
// shaped like OpenCode's TUI data. Run with the reactive Solid build:
//   bun --conditions=browser mods/subagents/solid/family.bench.ts [children] [messagesPerChild] [consumers]
// (without the condition Bun loads Solid's server build, which never re-runs a computation).
// A consumer is one computation that reads the family and its rows, as the dock's count, the
// rows under the composer and the queue's sidebar each do. Findings: opencode/notes/perf-many-sessions.md.
import { createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Reads } from "../opencode/view.ts"
import { subagents } from "../subagent-row.ts"
import { familyReader } from "./reader.ts"

const [children = 170, perChild = 100, consumers = 3] = process.argv.slice(2).map(Number)
const rootMessages = 300
const now = Date.now()

type Item = Record<string, unknown>
const tool = (name: string, input: Item, metadata: Item = {}): Item => ({
  type: "tool",
  name,
  state: { status: "completed", input, metadata, output: "x".repeat(400) },
  time: { created: now - 5000, completed: now - 4000 },
})
const step = (id: string, parts: Item[]): Item => ({
  type: "assistant",
  id,
  agent: "worker",
  model: { id: "claude-opus-5-5" },
  time: { created: now - 9000, completed: now - 1000 },
  content: parts,
})
const childIDs = Array.from({ length: children }, (_, i) => `ses_child_${i}`)
const rootItems: Item[] = Array.from({ length: rootMessages }, (_, i) =>
  step(`root_${i}`, [
    { type: "text", text: `step ${i} `.repeat(20), time: {} },
    i < children
      ? tool("subagent", { description: `unit-${i} implementor r1`, agent: "worker" }, { sessionID: childIDs[i] })
      : tool("read", { filePath: `/src/file-${i}.ts` }),
  ]),
)
const childItems = (c: number): Item[] =>
  Array.from({ length: perChild }, (_, i) =>
    step(`c${c}_${i}`, [
      { type: "reasoning", text: "thinking ".repeat(30), time: { created: now - 8000 } },
      tool("shell", { command: `bun test ${i}`, description: "run tests" }),
      tool("edit", { filePath: `/src/f${i}.ts`, oldString: "a", newString: "b" }),
      { type: "text", text: `done ${i} `.repeat(10), time: {} },
    ]),
  )

const [store, setStore] = createStore<{ messages: Record<string, Item[]> }>({
  messages: Object.fromEntries([["root", rootItems], ...childIDs.map((id, c) => [id, childItems(c)] as const)]),
})
const reads: Reads<string> = {
  session: {
    get: (id) => ({ id, parentID: id === "root" ? null : "root", title: id, agent: "worker", time: { created: now - 60_000, busy: now - 30_000 } }),
    root: () => "root",
    family: () => ["root", ...childIDs],
    status: (id) => (id === childIDs[0] ? "running" : "idle"),
    permission: { list: () => [] },
    form: { list: () => [] },
    message: { list: (id) => store.messages[id] ?? [] },
  },
  shell: { list: () => [] },
}

// One family reader per plugin, as prime's host and the queue's sidebar each make one.
const readers = Array.from({ length: consumers }, () => familyReader())
const t0 = performance.now()
const views = createRoot(() => readers.map((reader) => createMemo(() => subagents(reader(reads, "root"), "root").length)))
views.forEach((view) => view())
const first = performance.now() - t0

// A token streamed into the live child's newest text part.
// With no child messages loaded, into the root's newest text part.
const live = perChild > 0 ? childIDs[0]! : "root"
const last = (perChild > 0 ? perChild : rootMessages) - 1
const at = perChild > 0 ? 3 : 0
const stream = () =>
  setStore(
    produce((draft) => {
      const parts = draft.messages[live]![last]!.content as Item[]
      ;(parts[at] as { text: string }).text += " token"
    }),
  )
const tokens = 200
const t1 = performance.now()
for (let i = 0; i < tokens; i++) {
  stream()
  views.forEach((view) => view())
}
const perToken = (performance.now() - t1) / tokens
console.log(
  JSON.stringify({ children, perChild, rootMessages, consumers, firstReadMs: +first.toFixed(1), perTokenMs: +perToken.toFixed(2) }),
)
