// Each session's kernel description, frozen at its first request: the bytes a
// later request offers, the change it tells once, a subagent's own entry, and
// the entry kept over a restart and dropped with its session.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { description } from "./description.ts"
import type { Json } from "./frame.ts"
import * as Frozen from "./frozen.ts"
import type { Reached } from "./tools.ts"

const limits = { timeoutMs: 30_000, viewChars: 8_000 }
const read: Reached = { name: "read", description: "Read a file. More words.", input: { type: "object", properties: { path: { type: "string" } } } }
const edit: Reached = { name: "edit", description: "Edit a file.", input: {} }
const browse: Reached = { name: "browse_snapshot", description: "Snapshot the page. It lists elements.", input: {} }
const kernel: Reached = { name: "kernel", description: "itself", input: {} }

const memoryStore = (entries = new Map<string, Json>()): Frozen.Store & { readonly entries: Map<string, Json> } => ({
  entries,
  get: (key) => Effect.sync(() => entries.get(key)),
  set: (key, value) => Effect.sync(() => void entries.set(key, value)),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
})

const catalogs = (store: Frozen.Store, stamp = "words-1") => Effect.runSync(Frozen.make((tools) => description(limits, tools), stamp, store))
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("a session's description", () => {
  test("stays the bytes of its first request when a tool joins, and the join is told once", async () => {
    const frozen = catalogs(memoryStore())
    const first = frozen.describe([kernel, read, edit])
    expect(await run(frozen.offer("ses_1", first))).toEqual({ description: first })
    const joined = frozen.describe([kernel, read, edit, browse])
    expect(joined).not.toBe(first)
    expect(await run(frozen.offer("ses_1", joined))).toEqual({
      description: first,
      change: { added: [{ name: "browse_snapshot", summary: "Snapshot the page." }], removed: [] },
    })
    expect(await run(frozen.offer("ses_1", joined))).toEqual({ description: first })
  })

  test("tells a tool that leaves, and one that comes back, each once", async () => {
    const frozen = catalogs(memoryStore())
    const first = frozen.describe([read, edit, browse])
    await run(frozen.offer("ses_1", first))
    const left = frozen.describe([read, edit])
    expect(await run(frozen.offer("ses_1", left))).toEqual({ description: first, change: { added: [], removed: ["browse_snapshot"] } })
    expect(await run(frozen.offer("ses_1", left))).toEqual({ description: first })
    const back = frozen.describe([read, edit, browse])
    expect((await run(frozen.offer("ses_1", back))).change?.added.map((tool) => tool.name)).toEqual(["browse_snapshot"])
  })

  test("is a subagent's own: a session that starts after the join freezes the tools it starts with", async () => {
    const frozen = catalogs(memoryStore())
    const first = frozen.describe([read])
    await run(frozen.offer("ses_parent", first))
    const joined = frozen.describe([read, browse])
    expect(await run(frozen.offer("ses_child", joined))).toEqual({ description: joined })
    expect((await run(frozen.offer("ses_parent", joined))).description).toBe(first)
  })

  test("holds over a restart from its stored entry, and goes with its session", async () => {
    const store = memoryStore()
    const before = catalogs(store)
    const first = before.describe([read])
    await run(before.offer("ses_1", first))
    const after = catalogs(store)
    const joined = after.describe([read, edit])
    expect(await run(after.offer("ses_1", joined))).toEqual({ description: first, change: { added: [{ name: "edit", summary: "Edit a file." }], removed: [] } })
    await run(after.forget("ses_1"))
    expect(store.entries.size).toBe(0)
    expect(await run(after.offer("ses_1", joined))).toEqual({ description: joined })
  })

  test("takes the kernel's new words once when they change, and ignores a text it did not write", async () => {
    const store = memoryStore()
    const old = catalogs(store, "words-1")
    const first = old.describe([read])
    await run(old.offer("ses_1", first))
    const renewed = catalogs(store, "words-2")
    expect(await run(renewed.offer("ses_1", "a text no describe wrote"))).toEqual({ description: "a text no describe wrote" })
    const next = renewed.describe([read, edit])
    expect(await run(renewed.offer("ses_1", next))).toEqual({ description: next })
    expect(await run(renewed.offer("ses_1", "a text no describe wrote"))).toEqual({ description: next })
  })

  test("keeps the direct tools its first request carried; new words refreeze them once, and an older entry kept none", async () => {
    const store = memoryStore()
    const frozen = catalogs(store)
    const first = frozen.describe([read])
    expect(await run(frozen.offer("ses_1", first, ["memory_save"]))).toEqual({ description: first, direct: ["memory_save"] })
    // One that joins is not kept; one that leaves is not there to keep, and back when it returns.
    expect((await run(frozen.offer("ses_1", first, ["memory_save", "memory_forget"]))).direct).toEqual(["memory_save"])
    expect((await run(frozen.offer("ses_1", first, []))).direct).toEqual([])
    expect((await run(frozen.offer("ses_1", first, ["memory_forget", "memory_save"]))).direct).toEqual(["memory_save"])
    expect(store.entries.get(`${Frozen.FROZEN_PREFIX}ses_1`)).toMatchObject({ direct: ["memory_save"] })
    // A text no describe wrote keeps the frozen set too.
    expect((await run(frozen.offer("ses_1", "a text no describe wrote", ["memory_save", "memory_forget"]))).direct).toEqual(["memory_save"])
    // An entry written before the direct tools offered none, and keeps offering none under the same words.
    store.entries.set(`${Frozen.FROZEN_PREFIX}ses_old`, { stamp: "words-1", description: first, names: ["read"] })
    expect((await run(frozen.offer("ses_old", first, ["memory_save"]))).direct).toEqual([])
    // New words freeze the session again, its direct tools with it.
    const renewed = catalogs(store, "words-2")
    const next = renewed.describe([read])
    expect((await run(renewed.offer("ses_old", next, ["memory_save"]))).direct).toEqual(["memory_save"])
  })

  test("reads an entry it cannot decode as none", async () => {
    const store = memoryStore(new Map([[`${Frozen.FROZEN_PREFIX}ses_1`, { stamp: 1 }]]))
    const frozen = catalogs(store)
    const first = frozen.describe([read])
    expect(await run(frozen.offer("ses_1", first))).toEqual({ description: first })
  })
})

describe("the notice", () => {
  test("names each new tool with its first sentence and how to read its docs, and each gone one", () => {
    const text = Frozen.notice({ added: [{ name: "browse_snapshot", summary: "Snapshot the page." }, { name: "mcp-x", summary: "X." }], removed: ["webfetch"] })
    expect(text).toContain("The list in the kernel's description stays as it was")
    expect(text).toContain("read `tools.docs(name)` before the first call")
    expect(text).toContain("- tools.browse_snapshot: Snapshot the page.")
    expect(text).toContain('- tools["mcp-x"]: X.')
    expect(text).toContain("Gone (a call now throws):\n- tools.webfetch")
  })
})
