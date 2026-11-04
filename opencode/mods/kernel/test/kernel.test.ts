// The kernel against its real worker process: the host's Kernel for the
// worker's behaviour and limits, and the plugin against a fake OpenCode context
// for sessions, storage, reset and tool calls. No OpenCode, no model.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { Kernel, KernelError } from "../src/kernel.ts"
import { whollyDisabled } from "../src/host-tools.ts"
import type { Json, Listing, Omission } from "../src/protocol.ts"
import plugin from "../src/server.ts"

const work = mkdtempSync(join(tmpdir(), "kernel-test-"))
const started: Kernel[] = []
const start = async (timeoutMs = 5_000) => {
  const kernel = await Kernel.start({ cwd: work, timeoutMs })
  started.push(kernel)
  return kernel
}
const noTools = async (): Promise<Json> => {
  throw new Error("no tools in this test")
}
afterEach(() => {
  for (const kernel of started.splice(0)) kernel.kill()
})

describe("worker", () => {
  test("top-level bindings persist from one cell to the next", async () => {
    const kernel = await start()
    expect((await kernel.evaluate("let x = 1", [], noTools)).ok).toBe(true)
    expect((await kernel.evaluate("x + 1", [], noTools)).display).toBe("2")
  })

  test("a cell returns its console output, then its last value", async () => {
    const kernel = await start()
    const result = await kernel.evaluate('console.log("hello"); process.stdout.write("raw\\n"); 6 * 7', [], noTools)
    expect(result).toMatchObject({ ok: true, display: "hello\n42", output: "raw\n" })
  })

  test("a throw is a failed evaluation that keeps the bindings made before it", async () => {
    const kernel = await start()
    const result = await kernel.evaluate('const kept = 1; throw new TypeError("boom")', [], noTools)
    expect(result).toMatchObject({ ok: false, display: "TypeError: boom", bindings: ["kept"] })
    expect((await kernel.evaluate("kept", [], noTools)).display).toBe("1")
  })

  test("past the compute limit the worker is killed", async () => {
    const kernel = await start(300)
    const failure = await kernel.evaluate("while (true) {}", [], noTools).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KernelError)
    expect((failure as Error).message).toContain("0.3 s of compute")
    expect(kernel.alive).toBe(false)
  })

  test("the compute clock stops while a tool call runs", async () => {
    const kernel = await start(300)
    const tools: Listing[] = [{ id: "slow", description: "waits" }]
    const slow = async (_name: string, input: Json) => {
      await Bun.sleep(800)
      return input
    }
    const result = await kernel.evaluate('await tools.slow({ n: 1 })', tools, slow)
    expect(result).toMatchObject({ ok: true })
    expect(result.display).toContain("n: 1")
  })

  test("an unknown tool throws in the cell, naming the tools", async () => {
    const kernel = await start()
    const result = await kernel.evaluate("await tools.nope()", [{ id: "read", description: "r" }], noTools)
    expect(result).toMatchObject({ ok: false, display: "Error: tools.nope is not a tool here. Tools: tools.read" })
    const listed = await kernel.evaluate("tools.list()", [{ id: "read", description: "reads" }], noTools)
    expect(listed.display).toContain('id: "read"')
  })

  test("a snapshot restores into a fresh worker, functions left out", async () => {
    const first = await start()
    await first.evaluate('let n = 5; const m = new Map([["a", 1n]]); const f = () => 1', [], noTools)
    const snapshot = await first.snapshot()
    expect(snapshot.omitted).toEqual([{ name: "f", reason: "function" }])
    first.kill()
    const second = await start()
    expect(await second.restore(snapshot.bindings)).toEqual(["n", "m"])
    expect((await second.evaluate("[n, m.get('a')]", [], noTools)).display).toBe("[ 5, 1n ]")
  })

  test("a crash rejects the cell with the worker's exit", async () => {
    const kernel = await start()
    const failure = await kernel.evaluate("process.exit(3)", [], noTools).catch((error: unknown) => error)
    expect((failure as Error).message).toContain("exited (code 3)")
    expect(kernel.alive).toBe(false)
  })
})

/** Binds `code` in one worker, then restores its snapshot into a fresh one. */
const restart = async (code: string) => {
  const first = await start()
  expect((await first.evaluate(code, [], noTools)).ok).toBe(true)
  const snapshot = await first.snapshot()
  first.kill()
  const second = await start()
  const restored = await second.restore(snapshot.bindings)
  const show = async (expression: string) => (await second.evaluate(expression, [], noTools)).display
  return { snapshot, restored, show }
}

describe("a restart", () => {
  test("a cyclic object keeps its cycles and shared references", async () => {
    const { restored, show } = await restart("const node = { name: 'a', children: [] }; node.children.push(node); node.twin = node.children")
    expect(restored).toEqual(["node"])
    expect(await show("[node.children[0] === node, node.twin === node.children, node.name]")).toBe('[ true, true, "a" ]')
  })

  test("BigInt, collections, dates, patterns, errors, bytes and bare objects survive", async () => {
    const { snapshot, show } = await restart(`const v = {
      big: 2n ** 70n,
      map: new Map([[1n, new Set(["a"])]]),
      when: new Date(0),
      pattern: /x+/gi,
      error: Object.assign(new TypeError("bad"), { name: "BadInput" }),
      floats: new Float64Array([1.5]),
      buffer: Buffer.from("hi"),
      bare: Object.assign(Object.create(null), { k: 1 }),
    }`)
    expect(snapshot.omitted).toEqual([])
    const read = [
      "v.big",
      "v.map.get(1n).has('a')",
      "v.when.getTime()",
      "v.pattern.flags",
      "v.error instanceof TypeError",
      "v.error.name",
      "v.error.message",
      "v.floats[0]",
      "Buffer.isBuffer(v.buffer)",
      "v.buffer.toString()",
      "String(Object.getPrototypeOf(v.bare))",
      "v.bare.k",
    ]
    expect(await show(`[${read.join(", ")}].join(" ")`)).toBe("1180591620717411303424 true 0 gi true BadInput bad 1.5 true hi null 1")
  })

  test("a binding up to 16 MiB survives; one over is named too-large and left out", async () => {
    const { snapshot, restored, show } = await restart(
      "const mid = new Uint8Array(4 * 1024 * 1024).fill(7); const big = new Uint8Array(17 * 1024 * 1024); const small = 1",
    )
    expect(snapshot.omitted).toEqual([{ name: "big", reason: "too-large" }])
    expect(restored).toEqual(["mid", "small"])
    expect(await show("[mid.length, mid[mid.length - 1], small]")).toBe("[ 4194304, 7, 1 ]")
  })

  test("a closure made inside a function is left out and named", async () => {
    const { snapshot, restored } = await restart("function make() { let n = 0; return () => ++n }; const counter = make(); const holder = { counter }; const kept = 1")
    expect(snapshot.omitted).toContainEqual({ name: "counter", reason: "function" })
    expect(snapshot.omitted).toContainEqual({ name: "holder", reason: "function" })
    expect(restored).toEqual(["kept"])
  })

  test("live values and class instances are left out, each named with its reason", async () => {
    const { snapshot } = await restart(`const pending = Promise.resolve(1)
      const cache = new WeakMap()
      const steps = (function* () {})()
      class Point { constructor(x) { this.x = x } }
      const point = new Point(1)
      const lazy = { get v() { return 1 } }`)
    for (const omission of [
      { name: "pending", reason: "live" },
      { name: "cache", reason: "live" },
      { name: "steps", reason: "live" },
      { name: "point", reason: "instance of Point" },
      { name: "lazy", reason: "unsupported" },
    ] satisfies Omission[])
      expect(snapshot.omitted).toContainEqual(omission)
  })

  test("taking a snapshot runs no getter, trap, iterator or hook a cell wrote", async () => {
    const first = await start()
    // The values come first, so only what runs after the hooks are in counts.
    const setup = `var ran = 0
      const lazy = { get x() { ran++; return 1 } }
      const trap = new Proxy({}, { get() { ran++ }, ownKeys() { ran++; return [] }, getOwnPropertyDescriptor() { ran++ }, getPrototypeOf() { ran++; return null } })
      const early = new RangeError("early")
      const plain = { list: [1, , 3], map: new Map([[1, { polluted: 1 }]]), set: new Set([1]), early }
      Object.defineProperty(Error.prototype, "name", { get() { ran++; return "E" }, configurable: true })
      Error.prepareStackTrace = () => { ran++; return "hooked" }
      plain.late = new Error("late")
      Map.prototype.forEach = function () { ran++ }
      Map.prototype[Symbol.iterator] = function* () { ran++ }
      Set.prototype[Symbol.iterator] = function* () { ran++ }
      Object.defineProperty(Object.prototype, "polluted", { set() { ran++ }, configurable: true })
      ran`
    expect((await first.evaluate(setup, [], noTools)).display).toBe("0")
    const snapshot = await first.snapshot()
    await first.snapshot()
    expect((await first.evaluate("ran", [], noTools)).display).toBe("0")
    expect(snapshot.omitted).toContainEqual({ name: "lazy", reason: "unsupported" })
    expect(snapshot.omitted).toContainEqual({ name: "trap", reason: "unsupported" })
    expect(snapshot.bindings.map((binding) => binding.name)).toContain("plain")
  })
})

describe("whollyDisabled", () => {
  test("follows the last matching rule, as the registry does", () => {
    expect(whollyDisabled("execute", [{ action: "execute", resource: "*", effect: "deny" }])).toBe(true)
    expect(whollyDisabled("execute", [{ action: "*", resource: "*", effect: "deny" }, { action: "execute", resource: "*", effect: "allow" }])).toBe(false)
    expect(whollyDisabled("shell", [{ action: "shell", resource: "rm *", effect: "deny" }])).toBe(false)
  })
})

// ── plugin ────────────────────────────────────────────────────────────────

type Executor = (input: { code: string; reset?: boolean }, context: unknown) => Promise<{ content: string }>

/** A plugin context with one session, an in-memory storage and the tools given. */
const fakeContext = (options: Record<string, unknown>, tools: unknown[] = []) => {
  const storage = new Map<string, unknown>()
  const agentRules: unknown[] = []
  let kernel: Executor | undefined
  let registered: { options?: { runtime?: unknown } } | undefined
  let deleted: ((sessionID: string) => void) | undefined
  const ctx = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      // OpenCode's KV keeps JSON: a value must survive the round trip.
      set: async (key: string, value: unknown) => void storage.set(key, JSON.parse(JSON.stringify(value))),
      remove: async (key: string) => void storage.delete(key),
    },
    session: { get: async () => ({ location: { directory: work }, permissions: [] }) },
    agent: {
      get: async () => ({ data: { permissions: [] } }),
      transform: async (callback: (editor: unknown) => void) => {
        const agent = { id: "build", permissions: agentRules }
        callback({ list: () => [agent], update: (_id: string, update: (item: typeof agent) => void) => update(agent) })
        return { dispose: async () => undefined }
      },
    },
    tool: {
      list: async () => [...tools, { id: "kernel", description: "itself" }],
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { execute: Executor; options?: { runtime?: unknown } }) => {
            kernel = tool.execute
            registered = tool
          },
        })
        return { dispose: async () => undefined }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const sessionID = await new Promise<string | undefined>((resolve) => {
              deleted = resolve
              signal.addEventListener("abort", () => resolve(undefined), { once: true })
            })
            if (sessionID) yield { type: "session.deleted", data: { sessionID } }
          }
        },
      }),
    },
  }
  const call = (code: string, extra: { reset?: boolean; signal?: AbortSignal; runtime?: unknown } = {}) =>
    kernel!(
      { code, ...(extra.reset ? { reset: true } : {}) },
      {
        sessionID: "ses_1",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        signal: extra.signal ?? new AbortController().signal,
        progress: async () => undefined,
        ...(extra.runtime === undefined ? {} : { runtime: extra.runtime }),
      },
    ).then((result) => result.content)
  const fail = (code: string, extra: { runtime?: unknown } = {}) => call(code, extra).then(
    () => {
      throw new Error("expected the call to fail")
    },
    (error: Error) => error.message,
  )
  return {
    ctx,
    storage,
    agentRules,
    call,
    fail,
    registered: () => registered,
    deleteSession: (sessionID: string) => deleted?.(sessionID),
  }
}

const disposers: Array<() => unknown> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})
const setup = async (options: Record<string, unknown> = {}, tools: unknown[] = []) => {
  const fake = fakeContext(options, tools)
  const dispose = await plugin.setup(fake.ctx as never)
  if (dispose) disposers.push(dispose)
  return fake
}

const readTool = {
  id: "read",
  description: "Read a file",
  input: Schema.Struct({ path: Schema.String }),
  execute: async (input: { path: string }) => ({ content: await Bun.file(input.path).text() }),
}

// Stands for OpenCode's subagent tool, whose policy runs in hooks a cell skips.
const subagentTool = {
  id: "subagent",
  description: "Start a subagent",
  input: Schema.Struct({ prompt: Schema.String }),
  execute: async () => ({ content: "started" }),
}

describe("plugin", () => {
  test("state persists across calls, and reset clears it", async () => {
    const { call, fail, storage } = await setup()
    await call("let x = 1")
    expect(await call("x + 1")).toBe("2")
    expect((storage.get("kernel:ses_1") as { bindings: Array<{ name: string }> }).bindings.map((binding) => binding.name)).toEqual(["x"])
    expect(await call("typeof x", { reset: true })).toBe('[kernel reset]\nundefined')
    expect(storage.get("kernel:ses_1")).toEqual({ bindings: [] })
    expect(await fail("x")).toContain("ReferenceError")
  })

  test("a cell calls a tool through its execute, with the input decoded", async () => {
    const file = join(work, "note.txt")
    await Bun.write(file, "kept text")
    const { call, fail } = await setup({}, [readTool])
    expect(await call(`const text = await tools.read({ path: ${JSON.stringify(file)} }); text.length`)).toBe("9")
    expect(await fail("await tools.read({ path: 1 })")).toContain("Invalid input for read")
    expect(await fail("await tools.kernel({ code: '1' })")).toContain("Tools: tools.read")
  })

  test("a cell cannot start a subagent, whose guards run only for direct calls", async () => {
    const { call, fail } = await setup({}, [readTool, subagentTool])
    expect(await fail("await tools.subagent({ prompt: 'x' })")).toContain("Tools: tools.read")
    expect(await call("tools.list().map((tool) => tool.id).join()")).toBe("read")
  })

  test("the view keeps the head and tail of long output", async () => {
    const { call } = await setup({ viewChars: 100 })
    const view = await call('"a".repeat(300) + "END"')
    expect(view.length).toBeLessThan(160)
    expect(view.startsWith("a".repeat(50))).toBe(true)
    expect(view.endsWith("END")).toBe(true)
    expect(view).toContain("characters omitted")
  })

  test("a crash is a tool error, and the next call starts fresh from the stored bindings", async () => {
    const { call, fail } = await setup()
    await call("let kept = 7; const f = () => 1")
    expect(await fail("process.exit(5)")).toContain("exited (code 5)")
    expect(await call("[kept, typeof f]")).toBe('[new kernel; restored kept]\n[ 7, "undefined" ]')
  })

  test("a value over the old frame size survives a crash through storage, cycles and all", async () => {
    const { call, fail } = await setup()
    await call("const block = new Uint8Array(4 * 1024 * 1024).fill(3); const loop = { block }; loop.self = loop")
    expect(await fail("process.exit(5)")).toContain("exited (code 5)")
    expect(await call("[block.length, block[100], loop.self === loop, loop.block.length]")).toBe(
      "[new kernel; restored block, loop]\n[ 4194304, 3, true, 4194304 ]",
    )
  })

  test("a value that cannot be stored is named once, when it is bound", async () => {
    const { call } = await setup()
    expect(await call("const f = () => 1; 1")).toBe("[not kept across restarts: f (function)]\n1")
    expect(await call("2")).toBe("2")
  })

  test("the time limit kills a runaway cell; the next call restores", async () => {
    const { call, fail } = await setup({ timeoutMs: 300 })
    await call("let before = 1")
    expect(await fail("while (true) {}")).toContain("0.3 s of compute")
    expect(await call("before")).toBe("[new kernel; restored before]\n1")
  })

  test("deleting the session drops its worker and its stored bindings", async () => {
    const { call, storage, deleteSession } = await setup()
    await call("let gone = 1")
    expect(storage.has("kernel:ses_1")).toBe(true)
    deleteSession("ses_1")
    await Bun.sleep(50)
    expect(storage.has("kernel:ses_1")).toBe(false)
    expect(await call("typeof gone")).toBe("undefined")
  })

  test("without codeOnly, denyExecute denies code mode's execute to every agent", async () => {
    expect((await setup({ codeOnly: false })).agentRules).toEqual([{ action: "execute", resource: "*", effect: "deny" }])
    expect((await setup({ codeOnly: false, denyExecute: false })).agentRules).toEqual([])
    expect((await setup()).agentRules).toEqual([])
  })

  test("codeOnly makes the kernel the runtime, its description listing each tool it reaches with its input", async () => {
    const runtime = (await setup()).registered()?.options?.runtime as { describe: (tools: unknown[]) => string }
    const text = runtime.describe([
      { name: "read", description: "Read a file", input: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
      { name: "mcp-search", description: "Search", input: { type: "object", properties: { mode: { enum: ["a", "b"] } } } },
      { name: "kernel", description: "itself", input: {} },
    ])
    expect(text).toContain("### tools.read(input: { path: string, limit?: number })\nRead a file")
    expect(text).toContain('### tools["mcp-search"](input: { mode?: "a" | "b" })\nSearch')
    expect(text).not.toContain("tools.kernel")
    expect(text).toContain("the kernel is your only tool")
    expect((await setup({ codeOnly: false })).registered()?.options?.runtime).toBeUndefined()
  })

  test("with the runtime, a cell reaches every tool through it, subagent included, and a refusal throws", async () => {
    const calls: Array<[string, unknown]> = []
    const runtime = {
      tools: [
        { name: "read", description: "Read a file", input: {} },
        { name: "subagent", description: "Start a subagent", input: {} },
      ],
      call: async (name: string, input: unknown) => {
        calls.push([name, input])
        if (name === "read") throw new Error("It is the Sabbath")
        return { output: { sessionID: "ses_child", status: "completed", output: "done" } }
      },
    }
    const { call, fail } = await setup({}, [readTool])
    expect(await call("(await tools.subagent({ prompt: 'x' })).output", { runtime })).toBe("done")
    expect(await call("tools.list().map((tool) => tool.id).join()", { runtime })).toBe("read,subagent")
    expect(await fail("await tools.read({ path: 'a' })", { runtime })).toContain("It is the Sabbath")
    expect(calls).toEqual([
      ["subagent", { prompt: "x" }],
      ["read", { path: "a" }],
    ])
  })
})
