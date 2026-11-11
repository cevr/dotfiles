// The ledger over a Solid store, as OpenCode's TUI holds the session data: a
// turn's rows are those of the whole session's fold; a streamed token, or a
// part that changes no reading, reads nothing again; a step's end reads its
// message alone; and a session no row or sidebar reads asks for nothing.
// Bun's tests resolve solid-js to its server build, which never re-runs a
// computation, so this file takes the reactive build OpenCode loads.
import { expect, mock, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { judge, turnRows } from "../ledger.ts"
import { catalog, timeline } from "../opencode/view.ts"

const REACTIVE = { core: "solid-js/dist/solid.js", store: "solid-js/store/dist/store.js" }
mock.module("solid-js", () => import(REACTIVE.core))
mock.module("solid-js/store", () => import(REACTIVE.store))
const { createMemo, createRoot } = await import("solid-js")
const { createStore, produce } = await import("solid-js/store")
const { createLedger } = await import("./ledger.tsx")

const MINUTE = 60_000
const MODEL = { providerID: "anthropic", id: "claude-opus-5-5" }
const MODELS = [{ id: MODEL.id, providerID: MODEL.providerID, settings: { cache: { ttl: "1h" } }, cost: [{ input: 5, cache: { read: 0.5, write: 6.25 } }] }]
const PROVIDERS = [{ id: "anthropic" }]

type Item = Record<string, unknown>
const assistant = (id: string, at: number, prompt: number, read: number, finish: string): Item => ({
  type: "assistant",
  id,
  agent: "build",
  model: MODEL,
  finish,
  content: [{ type: "text", text: "step" }],
  tokens: { input: prompt - read - 200, cache: { read, write: 200 } },
  time: { created: at, streamed: at + 2_000, completed: at + 3_000 },
})

/** `turns` turns of a prompt, two steps and an idle marker; every third turn opens after the cache expired. */
function world(turns: number) {
  const items: Item[] = []
  let clock = 0
  let prompt = 20_000
  for (let turn = 0; turn < turns; turn++) {
    clock += turn % 3 === 0 ? 70 * MINUTE : MINUTE
    items.push({ type: "user", id: `user_${turn}`, time: { created: clock } })
    items.push(assistant(`msg_${turn}_0`, clock, prompt, turn % 3 === 0 ? 0 : prompt - 500, "tool-calls"))
    items.push(assistant(`msg_${turn}_1`, clock + 10_000, prompt + 300, prompt - 200, "stop"))
    items.push({ type: "idle", id: `idle_${turn}`, time: { created: clock + 20_000 } })
    prompt += 600
    clock += 20_000
  }
  const [store, setStore] = createStore<{ messages: Record<string, Item[]> }>({ messages: { root: items } })
  const calls = { list: 0, rpc: 0 }
  const handlers = new Map<string, (event: unknown) => void>()
  const data = {
    on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    session: {
      get: (id: string) => (id === "root" ? { id, parentID: null, tokens: { input: 1_000, cache: { read: 9_000, write: 500 } } } : undefined),
      family: () => ["root"],
      message: {
        list: (id: string) => {
          calls.list += 1
          return store.messages[id] ?? []
        },
        sync: () => Promise.resolve(),
      },
    },
    location: { agent: { list: () => [] }, model: { list: () => MODELS }, provider: { list: () => PROVIDERS } },
  }
  const rejecting = new Proxy(
    {},
    {
      get: () => () => {
        calls.rpc += 1
        return Promise.reject(new Error("no server"))
      },
    },
  )
  const ctx = { data, client: { rpc: () => rejecting }, location: undefined } as unknown as Plugin.Context
  /** The rows of every turn, as the whole session's fold answers them. */
  const folded = () => {
    const steps = timeline(store.messages.root!)
    const terms = catalog(MODELS, PROVIDERS)
    const judged = judge(steps, [], (model) => terms.get(model))
    return Array.from({ length: turns }, (_, turn) => turnRows(steps, judged, `msg_${turn}_1`))
  }
  return { store, setStore, calls, handlers, ctx, folded }
}

test("a turn's rows are those of the whole session's fold, and a streamed token reads nothing again", () => {
  const { setStore, calls, ctx, folded } = world(9)
  const ledger = createLedger(ctx)
  let runs = 0
  const { views, stop } = createRoot((stop) => ({
    views: Array.from({ length: 9 }, (_, turn) =>
      createMemo(() => {
        runs += 1
        return ledger.rows("root", `msg_${turn}_1`)
      }),
    ),
    stop,
  }))
  expect(views.map((view) => view())).toEqual(folded())
  expect(views.some((view) => view().length > 0)).toBe(true)
  const [lists, ran] = [calls.list, runs]
  setStore(produce((draft) => void ((draft.messages.root!.at(-2)!.content as Array<{ text: string }>)[0]!.text += " token")))
  setStore(produce((draft) => void (draft.messages.root!.at(-2)!.content as Item[]).push({ type: "reasoning", text: "" })))
  views.forEach((view) => view())
  expect([calls.list, runs]).toEqual([lists, ran])
  stop()
  ledger.dispose()
})

test("a step's end and a new step read that message, and the rows follow the fold", () => {
  const { setStore, calls, ctx, folded } = world(6)
  const ledger = createLedger(ctx)
  const { views, stop } = createRoot((stop) => ({ views: Array.from({ length: 7 }, (_, turn) => createMemo(() => ledger.rows("root", `msg_${turn}_1`))), stop }))
  views.forEach((view) => view())
  expect(views[5]!()).toEqual([])
  // The last step's usage lands, written inside its message: it read nothing of its 23k prompt.
  // The list is not read again, and the turn shows the miss the fold finds.
  const lists = calls.list
  setStore(produce((draft) => void ((draft.messages.root!.at(-2)! as Item).tokens = { input: 23_100, cache: { read: 0, write: 200 } })))
  expect(calls.list).toBe(lists)
  expect(views.slice(0, 6).map((view) => view())).toEqual(folded())
  expect(views[5]!()).toEqual([expect.stringContaining("cache miss · 23k tokens")])
  // A new turn after the cache expired: its rows appear.
  setStore(
    produce((draft) => {
      draft.messages.root!.push({ type: "user", id: "user_6", time: { created: 999 * MINUTE } })
      draft.messages.root!.push(assistant("msg_6_1", 999 * MINUTE, 30_000, 0, "stop"))
    }),
  )
  expect(views[6]!()).toEqual([expect.stringContaining("expired after")])
  stop()
  ledger.dispose()
})

test("an idle compaction's miss shows under the compaction, not under the turn that opens 36 hours later", () => {
  const { setStore, ctx } = world(1)
  const ledger = createLedger(ctx)
  // The turn closed at 70m; an idle compaction 55 minutes later reads only the system prompt of its 146k.
  const compactedAt = 70 * MINUTE + 10_000 + 55 * MINUTE
  const later = compactedAt + 36 * 60 * MINUTE + 16 * MINUTE
  setStore(
    produce((draft) => {
      const root = draft.messages.root!
      // The turn's closing step read its 166k prompt from the cache.
      root.at(-2)!.tokens = { input: 2, cache: { read: 161_469, write: 4_611 } }
      root.push({ type: "compaction", id: "cmp", status: "completed", model: MODEL, tokens: { input: 4, cache: { read: 17_611, write: 128_979 } }, time: { created: compactedAt } })
      root.push({ type: "idle", id: "idle_cmp", time: { created: compactedAt + 20_000 } })
      root.push({ type: "user", id: "user_late", time: { created: later } })
      root.push(assistant("msg_late_0", later, 43_227, 0, "tool-calls"))
      root.push(assistant("msg_late_1", later + 5_000, 44_276, 42_423, "stop"))
    }),
  )
  const { compaction, turn, stop } = createRoot((stop) => ({
    compaction: createMemo(() => ledger.rows("root", "cmp")),
    turn: createMemo(() => ledger.rows("root", "msg_late_1")),
    stop,
  }))
  expect(compaction()).toEqual([expect.stringMatching(/^cache miss · 129k tokens · \$[\d.]+ · the compaction request missed the cached prefix$/)])
  expect(turn()).toEqual([expect.stringMatching(/^cache miss · 43k tokens · \$[\d.]+ · expired after 36h 16m idle$/)])
  stop()
  ledger.dispose()
})

test("a session no row or sidebar reads is let go: its step ends ask nothing", async () => {
  const { calls, handlers, ctx } = world(3)
  const ledger = createLedger(ctx, { releaseMs: 1 })
  const stop = createRoot((stop) => {
    const view = createMemo(() => ledger.sidebar("root"))
    view()
    return stop
  })
  const stepEnded = () => handlers.get("session.step.ended")!({ data: { sessionID: "root" } })
  const asked = calls.rpc
  stepEnded()
  expect(calls.rpc).toBe(asked + 2)
  stop()
  await Bun.sleep(10)
  const after = calls.rpc
  stepEnded()
  await Bun.sleep(10)
  expect(calls.rpc).toBe(after)
  ledger.dispose()
})

test("the sidebar line of a family of hundreds reads token totals, and fetches no subagent's transcript", () => {
  const { store, calls, ctx } = world(3)
  const children = Array.from({ length: 300 }, (_, index) => `child_${index}`)
  const tokens = { input: 1_000, cache: { read: 9_000, write: 0 } }
  const synced: string[] = []
  const data = (ctx as unknown as { data: Record<string, Record<string, unknown>> }).data
  const session = data.session!
  const message = session.message as Record<string, unknown>
  session.get = (id: string) =>
    id === "root" || children.includes(id) ? { id, parentID: id === "root" ? null : "root", tokens } : undefined
  session.family = () => ["root", ...children]
  message.sync = (id: string) => {
    synced.push(id)
    return Promise.resolve()
  }
  // One subagent's transcript is already held, as when it was opened.
  message.list = (id: string) => (id === "child_7" ? store.messages.root! : (store.messages[id] ?? []))
  const ledger = createLedger(ctx)
  const asked = calls.rpc
  const line = createRoot((stop) => {
    const view = createMemo(() => ledger.sidebar("root"))
    const text = view()
    stop()
    return text
  })
  // The share is the family's: 9,000 read of 10,000 prompt tokens in each of 301 sessions.
  expect(line?.startsWith("Cache 90%")).toBe(true)
  expect(synced).toEqual([])
  // Only the root and the held subagent are judged, so only they ask the pool and the server.
  expect(calls.rpc - asked).toBe(4)
  ledger.dispose()
})
