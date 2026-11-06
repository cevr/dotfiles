// What one streamed token, and one step's end, cost the cache ledger in a large session,
// measured on the ledger (tui/ledger.tsx) over a Solid store shaped like OpenCode's TUI data.
// Run with the reactive Solid build:
//   bun --conditions=browser mods/cache/tui/ledger.bench.ts [messages] [footers] [events]
// (without the condition Bun loads Solid's server build, which never re-runs a computation).
// A footer is one turn's miss rows (tui/row.tsx) mounted in the transcript's tail; the
// sidebar line (tui/sidebar.tsx) reads the ledger once more.
//
// Measured on a Mac M-series, Bun 1.4.4, 8000 messages and 40 footers, before → after
// the incremental ledger: first read 3.1–5.9 s → 80–110 ms; a streamed token 0.005 ms
// both (no reading tracks a text); a part started 4.8–5.6 s → 0.04 ms; a step's end
// 4.8–6.3 s → 1.1–1.6 ms; a message added 5.0 s → 0.8–1.8 ms.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createLedger } from "./ledger.tsx"

const [messages = 8000, footers = 40, events = 20] = process.argv.slice(2).map(Number)
const now = Date.now()
const MODEL = { providerID: "anthropic", id: "claude-opus-5-5" }
const MINUTE = 60_000

type Item = Record<string, unknown>
const tool = (name: string, at: number, ms: number): Item => ({
  type: "tool",
  id: `tool_${at}`,
  name,
  state: { status: "completed", input: { command: "bun test" }, metadata: {}, content: [{ type: "text", text: "x".repeat(400) }] },
  time: { created: at, ran: at, completed: at + ms },
})
const assistant = (id: string, at: number, prompt: number, read: number, finish: string, parts: Item[]): Item => ({
  type: "assistant",
  id,
  agent: "build",
  model: MODEL,
  finish,
  content: [{ type: "text", text: `step ${id} `.repeat(20) }, ...parts],
  tokens: { input: prompt - read - 200, output: 300, reasoning: 0, cache: { read, write: 200 } },
  time: { created: at, streamed: at + 2000, completed: at + 3000 },
})

// Turns of five messages: a prompt, three steps (two call a tool), an idle marker. Every
// tenth turn opens after the cache expired, so the transcript has misses to draw.
const items: Item[] = []
const closing: string[] = []
let clock = now - (messages / 5) * 10 * MINUTE
let prompt = 20_000
for (let turn = 0; items.length + 5 <= messages - 2; turn++) {
  clock += turn % 10 === 0 ? 70 * MINUTE : MINUTE
  items.push({ type: "user", id: `user_${turn}`, text: "go", time: { created: clock } })
  for (let step = 0; step < 3; step++) {
    const id = `msg_${turn}_${step}`
    const read = step === 0 && turn % 10 === 0 ? 0 : prompt - 500
    items.push(assistant(id, clock, prompt, read, step < 2 ? "tool-calls" : "stop", step < 2 ? [tool("shell", clock + 2000, 5000)] : []))
    if (step === 2) closing.push(id)
    prompt += 300
    clock += 10_000
  }
  items.push({ type: "idle", id: `idle_${turn}`, time: { created: clock } })
}
// The live turn: a prompt and the step streaming into its text.
items.push({ type: "user", id: "user_live", text: "go", time: { created: clock } })
const live = { ...assistant("msg_live", clock, prompt, prompt - 500, "stop", []), finish: undefined, tokens: undefined, time: { created: clock } }
items.push(live)

const [store, setStore] = createStore<{ messages: Record<string, Item[]>; tokens: Record<string, unknown> }>({
  messages: { root: items },
  tokens: { input: 1000, cache: { read: 9000, write: 500 } },
})
const models = [
  {
    id: MODEL.id,
    providerID: MODEL.providerID,
    settings: { cache: { ttl: "1h" } },
    cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }],
  },
]
const data = {
  on: () => () => undefined,
  session: {
    get: (id: string) => (id === "root" ? { id, parentID: null, tokens: store.tokens } : undefined),
    family: () => ["root"],
    message: { list: (id: string) => store.messages[id] ?? [], sync: () => Promise.resolve() },
  },
  location: {
    agent: { list: () => [{ id: "build" }] },
    model: { list: () => models },
    provider: { list: () => [{ id: "anthropic" }] },
  },
}
const rejecting = new Proxy({}, { get: () => () => Promise.reject(new Error("no server")) })
const ctx = { data, client: { rpc: () => rejecting }, location: undefined } as unknown as Plugin.Context

const ledger = createLedger(ctx)
const tail = closing.slice(-footers)
const t0 = performance.now()
const views = createRoot(() => [
  ...tail.map((messageID) => createMemo(() => ledger.rows("root", messageID))),
  createMemo(() => ledger.sidebar("root")),
])
const read = () => views.reduce((n, view) => n + (view()?.length ?? 0), 0)
const shown = read()
const first = performance.now() - t0

// A token streamed into the live step's text part.
const token = () =>
  setStore(
    produce((draft) => {
      const parts = draft.messages.root!.at(-1)!.content as Item[]
      ;(parts[0] as { text: string }).text += " token"
    }),
  )
const tokens = 200
const t1 = performance.now()
for (let i = 0; i < tokens; i++) {
  token()
  read()
}
const perToken = (performance.now() - t1) / tokens

// A part started on the live step (a text, a reasoning or a tool call's input): its content grows.
const part = () =>
  setStore(
    produce((draft) => {
      ;(draft.messages.root!.at(-1)!.content as Item[]).push({ type: "reasoning", text: "" })
    }),
  )
const parts = events
const tp = performance.now()
for (let i = 0; i < parts; i++) {
  part()
  read()
}
const perPart = (performance.now() - tp) / parts

// A step's end: its usage and completion land on the live message.
const end = (i: number) =>
  setStore(
    produce((draft) => {
      const message = draft.messages.root!.at(-1)! as Item & { time: Item }
      message.tokens = { input: 100 + i, output: 10, reasoning: 0, cache: { read: prompt - 500, write: 200 } }
      message.time.completed = clock + 3000 + i
    }),
  )
const ends = events
const t2 = performance.now()
for (let i = 0; i < ends; i++) {
  end(i)
  read()
}
const perStep = (performance.now() - t2) / ends

// A message added: the next step's assistant message.
const append = (i: number) =>
  setStore(
    produce((draft) => {
      draft.messages.root!.push({ ...assistant(`msg_next_${i}`, clock + 5000 + i, prompt, prompt - 500, "tool-calls", []), tokens: undefined })
    }),
  )
const appends = events
const t3 = performance.now()
for (let i = 0; i < appends; i++) {
  append(i)
  read()
}
const perAppend = (performance.now() - t3) / appends
ledger.dispose()
console.log(
  JSON.stringify({
    messages: store.messages.root!.length,
    footers: tail.length,
    shown,
    firstReadMs: +first.toFixed(1),
    perTokenMs: +perToken.toFixed(3),
    perPartMs: +perPart.toFixed(2),
    perStepEndMs: +perStep.toFixed(2),
    perMessageAddedMs: +perAppend.toFixed(2),
  }),
)
